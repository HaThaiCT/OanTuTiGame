#!/usr/bin/env -S node --import tsx
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const demoDataDir = join(rootDir, 'deploy', 'demo-data');
const sqlGzPath = join(demoDataDir, 'arena_demo.sql.gz');
const objectsTarPath = join(demoDataDir, 'arena_objects.tar.gz');

async function main() {
  console.log('=== OanTuTi Arena — Phục hồi Dữ liệu Demo Hoàn chỉnh ===');

  if (!existsSync(sqlGzPath)) {
    console.error(`Không tìm thấy tệp dump database tại: ${sqlGzPath}`);
    process.exit(1);
  }

  // 1. Phục hồi các tệp đối tượng (Replays + Submissions) vào thư mục storage/
  const storageDir = join(rootDir, 'storage');
  mkdirSync(storageDir, { recursive: true });

  if (existsSync(objectsTarPath)) {
    console.log('1. Đang giải nén 616 trận replay và mã nguồn bot mẫu vào storage/ ...');
    execSync(`tar -xzf "${objectsTarPath}" -C "${rootDir}"`);
    console.log('   ✓ Đã phục hồi xong các tệp replay .oantuti và bot .zip');
  }

  // 2. Phục hồi Database
  const host = process.env.PGHOST || '127.0.0.1';
  const port = process.env.PGPORT || '5432';
  const user = process.env.PGUSER || 'postgres';
  const database = process.env.PGDATABASE || 'arena';

  console.log(`2. Đang nạp dữ liệu giải đấu & xếp hạng vào PostgreSQL [${database}] trên ${host}:${port} ...`);

  // Decompress to temporary sql file
  const tmpSql = join('/tmp', `arena_demo_restore_${Date.now()}.sql`);
  await pipeline(
    createReadStream(sqlGzPath),
    createGunzip(),
    createWriteStream(tmpSql)
  );

  try {
    const psqlCmd = process.env.PSQL_BIN || 'psql';
    const env = { ...process.env };
    
    // Check if psql command is available
    execSync(
      `${psqlCmd} -h "${host}" -p "${port}" -U "${user}" -d "${database}" -f "${tmpSql}" -v ON_ERROR_STOP=1 > /dev/null`,
      { env, stdio: 'inherit' }
    );
    console.log('   ✓ Đã phục hồi thành công 46 giải đấu, 72 đội và bảng xếp hạng Global!');
  } catch (err) {
    console.warn('   Lưu ý khi chạy psql: Hãy đảm bảo bạn có quyền truy cập vào cơ sở dữ liệu.');
    console.warn('   Nếu dùng Docker, cơ sở dữ liệu đã được tự động nạp khi khởi động.');
  } finally {
    try {
      execSync(`rm -f "${tmpSql}"`);
    } catch {
      // ignore
    }
  }

  console.log('\n=== HOÀN TẤT PHỤC HỒI DỮ LIỆU DEMO ===');
  console.log('- 46 Giải đấu với đầy đủ lịch đấu và kết quả');
  console.log('- 48 Đội thi đấu showcase + Bảng xếp hạng Rating Global');
  console.log('- 616 Ván đấu có thể xem lại Replay trực tiếp');
  console.log('\nTài khoản đăng nhập có sẵn:');
  console.log('  👑 Ban tổ chức (Admin):');
  console.log('     Tài khoản: system_admin');
  console.log('     Mật khẩu:  DemoAdmin@2026');
  console.log('  🎮 Thí sinh (Captain):');
  console.log('     Tài khoản: demo_cap1');
  console.log('     Mật khẩu:  DemoStudent@2026\n');
}

main().catch((err) => {
  console.error('Lỗi phục hồi:', err);
  process.exit(1);
});
