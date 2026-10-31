import { pipeline, env } from '@huggingface/transformers';

// 解决内网代理/镜像站可能存在的 SSL 证书问题
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 设置下载目录
const modelId = 'Xenova/bge-small-zh-v1.5';
const cacheDir = '/app/models';

env.cacheDir = cacheDir;
env.localModelPath = cacheDir;
env.allowRemoteModels = true;
// 优先使用国内镜像站
env.remoteHost = 'https://hf-mirror.com';

console.log(`Downloading model ${modelId} to ${cacheDir} via ${env.remoteHost}...`);

async function downloadWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempt ${i + 1}/${retries}...`);
      await pipeline('feature-extraction', modelId, {
        cache_dir: cacheDir,
      });
      console.log('Model downloaded successfully!');
      return;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) throw error;
      console.log('Retrying in 5 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

downloadWithRetry()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Final download failure:', err);
    process.exit(1);
  });
