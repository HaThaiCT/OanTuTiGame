import { cookies } from 'next/headers';
import Link from 'next/link';
import { getAuthProfile, getOrganizerSession, listTournaments } from '../../../lib/api';
import { tournamentRegistrationHref } from '../../../lib/navigation';
import TournamentRegistrationPanel from '../../tournaments/[id]/TournamentRegistrationPanel';

export const dynamic = 'force-dynamic';

export default async function JoinTournamentPage({ searchParams }: { searchParams: Promise<{ tournament?: string }> }) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  const profile = await getAuthProfile({ cookie });
  const tournaments = await listTournaments({ cookie });
  const query = await searchParams;
  const selected = tournaments.find((item) => item.id === query.tournament);
  return <section className="flex flex-col gap-5">
    <Link href="/workspace" className="text-sm underline">← Không gian đội</Link>
    <h1 className="text-2xl font-semibold">Đăng ký và theo dõi tham dự giải</h1>
    <p className="text-sm text-[var(--text-secondary)]">Chọn giải để gửi đăng ký không cần mã, xem xét duyệt hoặc hủy trước hạn. Chỉ đội trưởng được thay đổi đăng ký.</p>
    {!session ? <p className="text-sm">Bạn chưa đăng nhập. <Link href="/workspace" className="text-[var(--action)] underline">Đăng nhập để chọn đội →</Link></p> : session.scope !== 'FULL' ? <p className="text-sm">Hoàn tất đổi mật khẩu để tiếp tục. <Link href="/workspace" className="underline">Về không gian đội →</Link></p> : null}
    {profile === 'LAN_OFFLINE' ? <p className="text-sm">Hệ thống LAN: ADMIN ghi danh trực tiếp; sinh viên liên hệ ban tổ chức để thêm hoặc rút đội.</p> : null}
    {profile === null ? <p role="alert" className="text-sm text-[var(--danger-text)]">Không tải được hồ sơ máy chủ. Vui lòng tải lại trang; chưa thể thay đổi đăng ký.</p> : null}
    <form className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-2 text-sm">Chọn giải<select name="tournament" defaultValue={selected?.id ?? ''} required className="min-h-11 rounded-md border border-[var(--border-control)] bg-[var(--surface)] p-3"><option value="" disabled>Chọn giải để đăng ký hoặc xem trạng thái</option>{tournaments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button type="submit" disabled={tournaments.length === 0} className="min-h-11 self-end rounded-md border border-[var(--border-control)] px-4 py-3 text-sm disabled:opacity-60">Xem đăng ký</button>
    </form>
    {tournaments.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">Chưa có giải công khai để chọn. <Link href="/tournaments" className="underline">Xem danh sách giải</Link></p> : null}
    {query.tournament && !selected ? <p role="alert" className="text-sm">Không tìm thấy giải đã chọn. Hãy chọn lại từ danh sách.</p> : null}
    {selected ? <><Link href={tournamentRegistrationHref(selected.id)} className="self-start text-sm text-[var(--action)] underline">Trang giải và điều kiện đăng ký →</Link><div id="registration"><TournamentRegistrationPanel key={selected.id} tournamentId={selected.id} state={selected.state} registrationClosesAt={selected.registrationClosesAt} /></div></> : null}
  </section>;
}
