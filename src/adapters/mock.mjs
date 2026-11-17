import { BridgeError } from '../core.mjs';

// For isolated tests only. Not an LLM, does not read live DSH or contact any endpoint.
export class MockAdapter {
  kind = 'mock';
  constructor({ delayMs = 0, reply = ({message}) => `模拟回复：${message.text}` } = {}) { this.delayMs = delayMs; this.reply = reply; this.calls = []; }
  async generate(request) {
    this.calls.push({ sessionKey: request.sessionKey, text: request.message.text, persona: request.persona, policy: request.policy });
    await new Promise((resolve,reject)=> {
      request.signal.throwIfAborted();
      const done = () => { request.signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done,this.delayMs);
      const abort = () => { clearTimeout(timer); reject(request.signal.reason); };
      request.signal.addEventListener('abort', abort,{once:true});
    });
    return { text: await this.reply(request) };
  }
}
export class UnconfiguredAdapter {
  kind = 'unconfigured';
  async generate() { throw new BridgeError('DSH_NOT_CONFIGURED', '真实DSH适配尚未配置；不会连接日常DSH',503); }
}
