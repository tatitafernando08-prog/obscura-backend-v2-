import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule, DatabaseService } from '@app/database';

@Module({ imports: [AppConfigModule, DatabaseModule] })
class PromoteAdminModule {}

async function main() {
  const emailArg = process.argv.find((a) => a.startsWith('--email='));
  if (!emailArg) {
    console.error('Usage: npm run promote-admin -- --email=you@example.com');
    process.exit(1);
  }
  const email = emailArg.split('=')[1];

  const app = await NestFactory.createApplicationContext(PromoteAdminModule);
  const db = app.get(DatabaseService);

  const rows = await db.query<{ id: string }>(
    `update students set role = 'admin' where email = $1 returning id`,
    [email],
  );

  if (rows.length === 0) {
    console.error(`No student found with email ${email}. Sign up in the app first, then re-run this.`);
    process.exit(1);
  }

  console.log(`Promoted ${email} (id ${rows[0].id}) to admin.`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
