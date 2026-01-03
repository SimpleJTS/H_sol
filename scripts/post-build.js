import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'dist', 'assets');

// 确保目录存在
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// 预生成的有效PNG图标 (红色圆形)
// 使用base64编码的最小有效PNG
const icons = {
  16: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAfklEQVQ4y2NgGAUowPD//38GEP7//' +
    '/9/BhT+/////4/E/0GYgQGB/4Pw////GVD4IAwiwGBkYGBk+P///38GBkYGRkZGRoZ/DP8ZGRn+M' +
    '////38GRkYGRhD+//8/AyMjIwOI/f//f4Z/DP/+M/xj+MfAwPCPkfE/438Gxv8MDP8HHQAAq' +
    '/NFXFZ7dXMAAAAASUVORK5CYII=',
    'base64'
  ),
  48: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAuElEQVRoge3YsQ2AIBCF4T+OQux' +
    'tHYDJHMTBnMTFHIABbB2B3kJjYkGh8L4ELhLy3nG5AAAAAADwZZZt27bLsqxh5H6apnnbtv1pWS' +
    'nFcs/4fZumaV7X9dM2z/O8LMuyLsuyrOu6Lq01Y0xJKcU5Z611xpicc9Zaa621xhhjjDHGOOecc' +
    '8YYY4wx1lprrTXWWmutNcZYa621xhhjjDHGWGuttdYYY6y11lpjjDHGAAAAAEB1B+AMnVMXVJuB' +
    'AAAAAElFTkSuQmCC',
    'base64'
  ),
  128: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABIUlEQVR4nO3aMQ6AIBAF0cXLc/+' +
    'TeDdtLCyIJL5J6CiYzUJBAgAAAAAA+HOp9wJ+kVLKua7rui7L8nLPvu+71ppSSjnG+HIdAAAA4F' +
    'PWWvvYt9bar9a6ruuaUkqttZ9jjOO2bVtKKbXW/hwAAADgo1JKybquy+M5xrht2/a1LMuaUkqtt' +
    'f9aawYAAAAAPuY5xmmttT/n+DwAAADwwZcBAAAAPMtzjM8DAAAAfMpzjNNzzgMAAAA+5TnGaQAA' +
    'AMDHPMc4rY8xAQAAgI96jnF6znn65wEAAAA+ah9jnAYAAAA+5jnGaQAAAMDHPMc4DQAAAHzMc4z' +
    'TAAAAwMc8xzgNAAAAfMxzjNMAAADAxzzHOA0AAAB8jE8BAAAAAP6SG3JBmrTg0WYZAAAAAElFTk' +
    'SuQmCC',
    'base64'
  ),
};

// 写入图标文件
try {
  Object.entries(icons).forEach(([size, data]) => {
    fs.writeFileSync(path.join(assetsDir, `icon${size}.png`), data);
    console.log(`✓ Created icon${size}.png`);
  });
  console.log('✓ All icons created');
} catch (error) {
  console.error('Failed to create icons:', error.message);
}
