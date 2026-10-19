import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicTeamRatingProfile } from '../../../lib/api';
import { LiveTeamProfile } from '../../_components/RatingLivePanels';

export const dynamic = 'force-dynamic';

export default async function TeamRatingPage({ params }: { readonly params: Promise<{ readonly teamId: string }> }) {
  const { teamId } = await params;
  const result = await getPublicTeamRatingProfile(teamId);
  if (result.kind === 'notFound') notFound();
  if (result.kind === 'unavailable') return <section><h1 className="text-2xl font-semibold">Không tải được hồ sơ đội</h1><p className="mt-4 text-[var(--danger-text)]">{result.message}</p><LiveTeamProfile teamId={teamId} initial={null}/></section>;
  return <section className="flex flex-col gap-5"><header><h1 className="text-2xl font-semibold">{result.data.name}</h1><Link href="/rankings" className="text-sm text-[var(--action)]">← Bảng xếp hạng</Link></header><LiveTeamProfile teamId={teamId} initial={result.data}/></section>;
}
