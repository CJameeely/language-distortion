/**
 * voice-emotion-worker.js —— 在后台线程跑语音情绪模型（wav2vec2-base-superb-er）
 *
 * 模型推理一次要 1~2 秒，放在页面主线程会让画面每 3 秒卡一次，所以单独放在 Worker 里。
 * 由 语言失真.html 的 startML() 启动：
 *   页面 → {type:'load', lib, model}         加载模型
 *   页面 → {type:'classify', id, audio}      audio = 16kHz 单声道 Float32Array
 *   Worker → {type:'progress', value}        模型权重下载进度 0~100
 *   Worker → {type:'ready'} / {type:'error', message}
 *   Worker → {type:'result', id, result}     result = [{label, score}, …]，或 {type:'result', id, error}
 */
let classifier = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    try {
      const { pipeline, env } = await import(msg.lib);
      env.backends.onnx.wasm.numThreads = 1;
      classifier = await pipeline('audio-classification', msg.model, {
        dtype: 'q4', device: 'wasm',
        progress_callback(p) {   // 只报模型权重文件的进度（其余小文件会让进度条来回跳）
          if (p.status === 'progress' && p.file && p.file.endsWith('.onnx') && p.progress != null) {
            self.postMessage({ type: 'progress', value: p.progress });
          }
        },
      });
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
  } else if (msg.type === 'classify') {
    try {
      const result = await classifier(msg.audio, { top_k: 4 });
      self.postMessage({ type: 'result', id: msg.id, result });
    } catch (err) {
      self.postMessage({ type: 'result', id: msg.id, error: String(err) });
    }
  }
};
