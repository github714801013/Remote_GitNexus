import { pipeline, env } from '@huggingface/transformers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 解决内网代理/镜像站可能存在的 SSL 证书问题
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 设置下载目录为当前脚本目录下的 models
const cacheDir = path.join(__dirname, 'models');

env.cacheDir = cacheDir;
env.localModelPath = cacheDir;
env.allowRemoteModels = true;
// 优先使用国内镜像站
env.remoteHost = 'https://hf-mirror.com';

const models = ['Xenova/bge-small-zh-v1.5', 'Alibaba-NLP/gte-Qwen2-1.5B-instruct'];

async function downloadWithRetry(modelId, retries = 3) {
  console.log(`\nDownloading model ${modelId} to ${cacheDir}...`);
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempt ${i + 1}/${retries}...`);
      // transformers.js v3 自动处理目录结构
      await pipeline('feature-extraction', modelId, {
        device: 'cpu', // 下载时不需要 GPU
      });
      console.log(`Model ${modelId} downloaded successfully!`);
      return;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) throw error;
      console.log('Retrying in 5 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function main() {
  for (const model of models) {
    await downloadWithRetry(model);
  }
}

main()
  .then(() => {
    console.log('\nAll models downloaded successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFinal download failure:', err);
    process.exit(1);
  });
