// Disposable, localhost-only UI fixture. Does not touch the production database.
import { createApp } from '../dist/app.js';
import { randomBytes, randomUUID } from 'node:crypto';
const app = createApp({
  host: '127.0.0.1',
  port: 3101,
  dbPath: ':memory:',
  jwtSecret: randomBytes(48).toString('hex'),
  setupToken: 'xpsync-preview-setup',
  clientOrigins: ['*'],
});
const p = app.store.createProject(
  'Website mùa thu',
  'Thiết kế trải nghiệm mới cho mùa ra mắt tháng 10.',
);
app.store.createProject('Ứng dụng nội bộ', 'Công cụ giúp nhóm làm việc hiệu quả hơn.');
app.store.createProject('Nội dung & thương hiệu', 'Kể câu chuyện của chúng ta theo cách riêng.');
for (const [index, title] of [
  'Thiết kế hệ thống giao diện',
  'Hoàn thiện trang giới thiệu',
  'Kiểm thử trải nghiệm di động',
  'Chuẩn bị nội dung ra mắt',
  'Thiết lập cơ sở dữ liệu',
].entries())
  app.store.apply(p.id, index % 2 ? 'Bob' : 'Alice', {
    type: 'task:push_mutation',
    mutationId: randomUUID(),
    taskId: randomUUID(),
    operation: 'upsert',
    timestamp: Date.now() - index * 60000,
    changes: {
      title,
      isDone: index === 0 || index === 4,
      timeSpent: index * 1500000,
      timeEstimate: 7200000,
    },
  });
await app.listen();
console.log(
  'Disposable UI preview: http://127.0.0.1:3101/admin/ (setup token: xpsync-preview-setup)',
);
process.on('SIGINT', () => void app.close());
process.on('SIGTERM', () => void app.close());
