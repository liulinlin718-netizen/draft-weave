import { buildPolishInput, serializeProject } from './core.mjs';

export const POLISH_HTTP_BODY_LIMIT = 2_000_000;
export const POLISH_INPUT_CHARACTER_LIMIT = 1_800_000;
const encoder = new TextEncoder();

export class PolishRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'PolishRequestError'; this.code = code; Object.assign(this, details);
  }
}

/** Pure preflight: measures the exact JSON body without pruning any manuscript data. */
export function preflightPolishRequest(project, { requestId, provider } = {}) {
  if (!['external-api', 'codex-cli'].includes(provider)) throw new PolishRequestError('INVALID_PROVIDER', '请选择 external-api 或 codex-cli。');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new PolishRequestError('INVALID_REQUEST_ID', '润色请求 ID 无效。');
  const input = buildPolishInput(project);
  if (input.blocks.every(block => block.locked === true)) throw new PolishRequestError('ALL_BLOCKS_LOCKED', '所有段落均已锁定。请先解锁需要润色的段落；尚未发送模型请求。');
  const payload = { requestId, provider, input };
  const serializedBody = JSON.stringify(payload);
  const requestBytes = encoder.encode(serializedBody).byteLength;
  const inputCharacters = JSON.stringify(input).length;
  if (requestBytes > POLISH_HTTP_BODY_LIMIT) throw new PolishRequestError('INPUT_TOO_LARGE', '完整润色请求超过 2 MB；请减少项目内容后重试。文稿和来源未被裁剪，尚未发送。', { limit: POLISH_HTTP_BODY_LIMIT, actual: requestBytes, unit: 'utf8-bytes', requestBytes, inputCharacters });
  if (inputCharacters > POLISH_INPUT_CHARACTER_LIMIT) throw new PolishRequestError('INPUT_TOO_LARGE', '完整模型输入超过 180 万字符；请减少项目内容后重试。文稿和来源未被裁剪，尚未发送。', { limit: POLISH_INPUT_CHARACTER_LIMIT, actual: inputCharacters, unit: 'utf16-code-units', requestBytes, inputCharacters });
  return { payload, serializedBody, requestBytes, inputCharacters };
}

/** requestId is intentionally excluded: it identifies transport, not manuscript/configuration. */
export async function preparePolishRequest(project, options = {}) {
  const preflight = preflightPolishRequest(project, options);
  const { provider, configurationId, instructionVersion } = options;
  if (typeof configurationId !== 'string' || !/^dwc1_[A-Za-z0-9_-]{43}$/.test(configurationId) || typeof instructionVersion !== 'string' || !instructionVersion || instructionVersion.length > 200) {
    throw new PolishRequestError('CONFIGURATION_UNAVAILABLE', '尚未获得有效的服务端配置标识，请重新检查连接。');
  }
  const signed = JSON.stringify({ signatureVersion: 1, provider, configurationId, instructionVersion, input: preflight.payload.input });
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(signed));
  const inputSignature = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  return { ...preflight, provider, configurationId, instructionVersion, inputSignature };
}

/** Reuse is stricter than acceptance: only exact current input and configuration may match. */
export function canReusePolishReview(project, prepared) {
  const review = project?.review;
  const metadata = review?.metadata;
  if (!review || !metadata || !prepared || review.staleAtCreation || review.expectedRevision !== project.revision || !Array.isArray(review.changes) || review.changes.some(change => change.status === 'stale' || (change.status === 'pending' && (!Array.isArray(change.issues) || change.issues.length)))) return false;
  if (typeof prepared.inputSignature !== 'string' || !/^[a-f0-9]{64}$/.test(prepared.inputSignature)) return false;
  if (!['provider', 'configurationId', 'instructionVersion', 'inputSignature'].every(key => typeof prepared[key] === 'string' && metadata[key] === prepared[key])) return false;
  try {
    // Validate the complete current state, source provenance and review guards.
    // Historical snapshots are deliberately not walked for a reuse decision.
    serializeProject({ ...project, history: [] });
    return true;
  } catch { return false; }
}
