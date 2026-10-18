'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { TournamentSummary } from '../../lib/api';
import { formatLabel, stateLabel } from '../../lib/labels';

const formats = [{id:'ALL',label:'Tất cả',color:'#b4b5bb'},{id:'SINGLE_ELIMINATION',label:'Loại trực tiếp',color:'#e18caa'},{id:'SWISS_PLAYOFF',label:'Swiss → Playoff',color:'#a799df'},{id:'ROUND_ROBIN',label:'Vòng tròn',color:'#79acd5'},{id:'ELO_ARENA',label:'Elo Arena',color:'#75c9a5'}];
export default function TournamentCatalog({tournaments}:{tournaments:TournamentSummary[]}) {
  const [query,setQuery]=useState('');
  const [format,setFormat]=useState('ALL');
  const [page, setPage] = useState(0);
  const visible=tournaments.filter(t=>(format==='ALL'||t.format===format)&&t.name.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')));
  const pageCount = Math.max(1, Math.ceil(visible.length / 4));
  const currentPage = Math.min(page, pageCount - 1);
  return <section id="tournaments" aria-label="Giải đấu OanTuTi">
    <div className="arena-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input aria-label="Tìm giải đấu" placeholder="Tìm giải đấu OanTuTi" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><button type="button" className="whitespace-nowrap text-xs" onClick={()=>{setQuery('');setFormat('ALL');setPage(0);}}>Tất cả giải đấu</button></div>
    <div className="arena-filters" aria-label="Lọc thể thức">{formats.map(f=><button key={f.id} type="button" style={{color:f.color}} aria-pressed={format===f.id} onClick={()=>{setFormat(f.id);setPage(0);}}>▧ {f.label}</button>)}</div>
    <div className="arena-section-heading"><h2>Đấu trường OanTuTi</h2><div className="arena-pagination"><span aria-live="polite">{visible.length} giải · {currentPage + 1}/{pageCount}</span><button aria-label="Trang giải trước" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>←</button><button aria-label="Trang giải tiếp" disabled={currentPage>=pageCount-1} onClick={()=>setPage(currentPage+1)}>→</button></div></div>
    {visible.length===0?<div className="arena-empty">{tournaments.length===0?'Chưa có giải được công bố.':'Không có giải phù hợp bộ lọc.'}</div>:<div className="arena-catalog">{visible.slice(currentPage*4,currentPage*4+4).map((t,index)=><Link className="arena-tournament-card" key={t.id} href={`/tournaments/${t.id}`}>
      <div className="arena-tournament-card-art"><BoardArtwork variant={index%4}/></div>
      <div className="arena-tournament-card-body"><span className="arena-status" style={t.state==='RUNNING'?{color:'var(--live-accent)'}:undefined}>{stateLabel[t.state]??t.state}</span><h3>{t.name}</h3><p className="mt-2 text-xs text-[var(--text-secondary)]">{formatLabel[t.format]??t.format}</p><div className="arena-card-meta"><span>Tối đa {t.maxTeams} đội</span><span>·</span><span>{t.rulesRevision}</span></div></div>
    </Link>)}</div>}
  </section>;
}
function BoardArtwork({variant}:{variant:number}) {
  const glowId = useId();
  const colors=['#c7a963','#78a98f','#839cb9','#ad8fbb'];
  const accent=colors[variant];
  return <svg viewBox="0 0 320 180" role="img" aria-label="Minh họa bàn cờ OanTuTi, không phải trạng thái ván đấu"><defs><radialGradient id={glowId}><stop stopColor={accent} stopOpacity=".35"/><stop offset="1" stopColor="#17181b"/></radialGradient></defs><rect width="320" height="180" fill={`url(#${glowId})`}/><g transform="translate(160 90) rotate(-24) skewX(12) translate(-100 -70)">{Array.from({length:64},(_,i)=><rect key={i} x={(i%8)*25} y={Math.floor(i/8)*18} width="24" height="17" fill={(Math.floor(i/8)+i%8)%2===0?accent:'#2c2e32'} opacity={(Math.floor(i/8)+i%8)%2===0?'.38':'.8'}/>)}{[9,18,10,45,54,53].map((pos,i)=><g key={pos} transform={`translate(${(pos%8)*25+12} ${Math.floor(pos/8)*18+8})`}><circle r="9" fill={i<3?'#ece8de':'#17181b'} stroke={accent}/><text textAnchor="middle" y="3" fontSize="9" fill={i<3?'#17181b':'#ece8de'}>{['B','K','G'][i%3]}</text></g>)}</g></svg>;
}
