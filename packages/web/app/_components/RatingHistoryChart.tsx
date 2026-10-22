'use client';

import { useId, useMemo, useState } from 'react';
import type { RatingChangeDto } from '@oantuti/protocol';

export function getRankName(rating: number | null): string {
  if (rating === null) return 'UNRATED';
  if (rating < 1200) return 'NEWBIE';
  if (rating < 1400) return 'PUPIL';
  if (rating < 1600) return 'SPECIALIST';
  if (rating < 1900) return 'EXPERT';
  if (rating < 2100) return 'CANDIDATE_MASTER';
  if (rating < 2300) return 'MASTER';
  if (rating < 2400) return 'INTERNATIONAL_MASTER';
  if (rating < 2600) return 'GRANDMASTER';
  if (rating < 3000) return 'INTERNATIONAL_GRANDMASTER';
  return 'LEGENDARY_GRANDMASTER';
}
export interface RankBand {
  readonly rank: string;
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly darkColor: string;
  readonly lightColor: string;
  readonly textColor: string;
}

export const RANK_BANDS: readonly RankBand[] = [
  { rank: 'LEGENDARY_GRANDMASTER', name: 'Legendary Grandmaster', min: 3000, max: 4000, darkColor: 'rgba(185, 28, 28, 0.22)', lightColor: 'rgba(185, 28, 28, 0.1)', textColor: '#ff737d' },
  { rank: 'GRANDMASTER', name: 'Grandmaster', min: 2400, max: 3000, darkColor: 'rgba(239, 68, 68, 0.16)', lightColor: 'rgba(220, 38, 38, 0.08)', textColor: '#ff737d' },
  { rank: 'MASTER', name: 'Master', min: 2100, max: 2400, darkColor: 'rgba(251, 146, 60, 0.16)', lightColor: 'rgba(234, 88, 12, 0.08)', textColor: '#fb923c' },
  { rank: 'CANDIDATE_MASTER', name: 'Candidate Master', min: 1900, max: 2100, darkColor: 'rgba(192, 132, 252, 0.16)', lightColor: 'rgba(147, 51, 234, 0.08)', textColor: '#c084fc' },
  { rank: 'EXPERT', name: 'Expert', min: 1600, max: 1900, darkColor: 'rgba(129, 140, 248, 0.16)', lightColor: 'rgba(29, 78, 216, 0.08)', textColor: '#818cf8' },
  { rank: 'SPECIALIST', name: 'Specialist', min: 1400, max: 1600, darkColor: 'rgba(56, 189, 248, 0.16)', lightColor: 'rgba(14, 116, 144, 0.08)', textColor: '#38bdf8' },
  { rank: 'PUPIL', name: 'Pupil', min: 1200, max: 1400, darkColor: 'rgba(0, 245, 212, 0.16)', lightColor: 'rgba(4, 120, 87, 0.08)', textColor: '#00f5d4' },
  { rank: 'NEWBIE', name: 'Newbie', min: 0, max: 1200, darkColor: 'rgba(154, 166, 177, 0.12)', lightColor: 'rgba(75, 85, 99, 0.06)', textColor: '#9aa6b1' },
];

export function getRankColor(rating: number): string {
  if (rating >= 2400) return '#ff737d';
  if (rating >= 2100) return '#fb923c';
  if (rating >= 1900) return '#c084fc';
  if (rating >= 1600) return '#818cf8';
  if (rating >= 1400) return '#38bdf8';
  if (rating >= 1200) return '#00f5d4';
  return '#9aa6b1';
}

export interface ChartPoint {
  readonly publicationOrder: string;
  readonly newRating: number;
  readonly tournamentName: string;
  readonly delta: number | null;
  readonly rankName: string;
  readonly x: number;
  readonly y: number;
}

export interface RatingHistoryChartProps {
  readonly points: readonly Pick<RatingChangeDto, 'publicationOrder' | 'newRating' | 'tournamentName'>[];
  readonly teamName?: string;
}

export default function RatingHistoryChart({ points, teamName }: RatingHistoryChartProps) {
  const gradientId = useId();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const sorted = useMemo(() => {
    return [...points].sort((a, b) => {
      const pa = BigInt(a.publicationOrder);
      const pb = BigInt(b.publicationOrder);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }, [points]);

  const { chartPoints, visibleBands, yMin, yMax, plotWidth, plotHeight, padL, padT } = useMemo(() => {
    if (sorted.length === 0) {
      return { chartPoints: [], visibleBands: [], yMin: 0, yMax: 0, plotWidth: 0, plotHeight: 0, padL: 0, padT: 0 };
    }

    const values = sorted.map((p) => p.newRating);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);

    // Padding bounds for Y axis, snap to 100
    const rawMin = Math.max(0, Math.floor((minVal - 120) / 100) * 100);
    const rawMax = Math.min(4000, Math.ceil((maxVal + 120) / 100) * 100);
    const span = Math.max(300, rawMax - rawMin);
    const calcMin = rawMin;
    const calcMax = rawMin + span;

    const width = 840;
    const height = 360;
    const paddingLeft = 55;
    const paddingRight = 145;
    const paddingTop = 30;
    const paddingBottom = 45;

    const pWidth = width - paddingLeft - paddingRight;
    const pHeight = height - paddingTop - paddingBottom;

    const n = sorted.length;
    const calculatedPoints: ChartPoint[] = sorted.map((pt, i) => {
      const x = n === 1 ? paddingLeft + pWidth / 2 : paddingLeft + (i / (n - 1)) * pWidth;
      const y = paddingTop + pHeight - ((pt.newRating - calcMin) / span) * pHeight;
      const delta = i > 0 ? pt.newRating - sorted[i - 1].newRating : null;
      const rName = getRankName(pt.newRating);
      return {
        publicationOrder: pt.publicationOrder,
        newRating: pt.newRating,
        tournamentName: pt.tournamentName,
        delta,
        rankName: rName,
        x,
        y,
      };
    });

    // Determine intersecting rank bands
    const intersecting = RANK_BANDS.map((band) => {
      const top = Math.min(band.max, calcMax);
      const bottom = Math.max(band.min, calcMin);
      if (top <= bottom) return null;

      const yTop = paddingTop + pHeight - ((top - calcMin) / span) * pHeight;
      const yBottom = paddingTop + pHeight - ((bottom - calcMin) / span) * pHeight;
      return {
        ...band,
        y: yTop,
        height: Math.max(0, yBottom - yTop),
        thresholdY: yTop,
      };
    }).filter((b): b is NonNullable<typeof b> => b !== null);

    return {
      chartPoints: calculatedPoints,
      visibleBands: intersecting,
      yMin: calcMin,
      yMax: calcMax,
      plotWidth: pWidth,
      plotHeight: pHeight,
      padL: paddingLeft,
      padT: paddingTop,
    };
  }, [sorted]);

  if (sorted.length === 0) {
    return (
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm font-mono text-center text-sm text-[var(--text-secondary)]">
        // CHƯA CÓ LỊCH SỬ RATING CÔNG BỐ CHO ĐỘI NÀY.
      </section>
    );
  }

  const latest = chartPoints[chartPoints.length - 1];
  const maxPoint = [...chartPoints].sort((a, b) => b.newRating - a.newRating)[0];
  const activeHover = hoveredIdx !== null ? chartPoints[hoveredIdx] : null;

  // Polyline coordinates
  const polylineCoords = chartPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Polygon area for subtle gradient fill
  const areaCoords = `${chartPoints[0].x.toFixed(1)},${(padT + plotHeight).toFixed(1)} ${polylineCoords} ${latest.x.toFixed(1)},${(padT + plotHeight).toFixed(1)}`;

  // Ticks on Y axis (every 200 or at tier thresholds)
  const yTicks: number[] = [];
  for (let r = Math.ceil(yMin / 200) * 200; r <= yMax; r += 200) {
    yTicks.push(r);
  }

  return (
    <section className="flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm transition-all">
      {/* Header Stat Strip (Codeforces Style) */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4 font-mono">
        <div>
          <h3 className="font-heading text-base font-bold text-[var(--text-primary)] uppercase tracking-wide">
            BIỂU ĐỒ BIẾN ĐỘNG RATING {teamName ? `— ${teamName}` : ''}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            Theo dõi diễn biến điểm số qua các giải đấu theo chuẩn phân cấp Codeforces / Online Judge
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
            <span className="text-[var(--text-secondary)]">HIỆN TẠI:</span>
            <span className="font-bold font-heading text-sm" style={{ color: getRankColor(latest.newRating) }}>
              {latest.newRating}
            </span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
            <span className="text-[var(--text-secondary)]">CAO NHẤT:</span>
            <span className="font-bold font-heading text-sm" style={{ color: getRankColor(maxPoint.newRating) }}>
              {maxPoint.newRating}
            </span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
            <span className="text-[var(--text-secondary)]">SỐ GIẢI:</span>
            <span className="font-bold text-[var(--text-primary)]">
              {chartPoints.length}
            </span>
          </div>
        </div>
      </div>

      {/* Main SVG Interactive Chart */}
      <div className="relative mt-4 w-full overflow-hidden select-none">
        <svg
          viewBox="0 0 840 360"
          className="w-full h-auto max-h-[420px] overflow-visible font-mono"
          role="img"
          aria-label="Biểu đồ lịch sử rating theo thang bậc"
        >
          <defs>
            <linearGradient id={`chart-fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={getRankColor(latest.newRating)} stopOpacity="0.28" />
              <stop offset="100%" stopColor={getRankColor(latest.newRating)} stopOpacity="0.0" />
            </linearGradient>
            <filter id={`glow-${gradientId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* 1. Codeforces Colored Rank Tier Horizontal Bands */}
          {visibleBands.map((band) => (
            <g key={band.rank}>
              {/* Colored Band Background */}
              <rect
                x={padL}
                y={band.y}
                width={plotWidth}
                height={band.height}
                fill={band.darkColor}
                className="transition-colors"
              />

              {/* Band Threshold Line */}
              <line
                x1={padL}
                y1={band.y}
                x2={padL + plotWidth}
                y2={band.y}
                stroke="currentColor"
                strokeOpacity={0.15}
                strokeDasharray="4 4"
              />

              {/* Rank Tier Label on the right axis */}
              <text
                x={padL + plotWidth + 8}
                y={band.y + 14}
                fill={band.textColor}
                fontSize={9.5}
                fontWeight="700"
                letterSpacing="0.02em"
                className="select-none"
              >
                {band.name} ({band.min})
              </text>
            </g>
          ))}

          {/* 2. Y-Axis Numerical Grid Lines and Ticks */}
          {yTicks.map((tick) => {
            const y = padT + plotHeight - ((tick - yMin) / (yMax - yMin)) * plotHeight;
            return (
              <g key={`tick-${tick}`}>
                <line
                  x1={padL - 4}
                  y1={y}
                  x2={padL}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                />
                <text
                  x={padL - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  fill="var(--text-secondary)"
                  fontSize={10}
                  className="tabular-nums select-none"
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {/* 3. Subtle Area Fill Under Trajectory */}
          {chartPoints.length > 1 ? (
            <polygon points={areaCoords} fill={`url(#chart-fill-${gradientId})`} />
          ) : null}

          {/* 4. Rating Trajectory Polyline */}
          {chartPoints.length > 1 ? (
            <polyline
              points={polylineCoords}
              fill="none"
              stroke={getRankColor(latest.newRating)}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              filter={`url(#glow-${gradientId})`}
            />
          ) : null}

          {/* 5. Hover Crosshair */}
          {activeHover ? (
            <g>
              <line
                x1={activeHover.x}
                y1={padT}
                x2={activeHover.x}
                y2={padT + plotHeight}
                stroke="var(--action)"
                strokeWidth={1.2}
                strokeDasharray="3 3"
                opacity={0.8}
              />
              <line
                x1={padL}
                y1={activeHover.y}
                x2={padL + plotWidth}
                y2={activeHover.y}
                stroke="var(--action)"
                strokeWidth={1.2}
                strokeDasharray="3 3"
                opacity={0.8}
              />
            </g>
          ) : null}

          {/* 6. Interactive Data Point Nodes */}
          {chartPoints.map((pt, i) => {
            const isHovered = hoveredIdx === i;
            const ptColor = getRankColor(pt.newRating);
            const isLatest = i === chartPoints.length - 1;

            return (
              <g
                key={pt.publicationOrder}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
                onClick={() => setHoveredIdx(hoveredIdx === i ? null : i)}
              >
                {/* Hit test circle for hover & touch */}
                <circle cx={pt.x} cy={pt.y} r={18} fill="transparent" pointerEvents="all" />

                {/* Outer halo for hover / latest */}
                {isHovered || isLatest ? (
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={isHovered ? 9 : 7}
                    fill={ptColor}
                    opacity={isHovered ? 0.35 : 0.25}
                    className="transition-all"
                  />
                ) : null}

                {/* Point Node */}
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 5.5 : 4}
                  fill={ptColor}
                  stroke="var(--surface)"
                  strokeWidth={2}
                  className="transition-all"
                />

                {/* X-axis tick / contest label */}
                <text
                  x={pt.x}
                  y={padT + plotHeight + 16}
                  textAnchor="middle"
                  fill={isHovered ? 'var(--action)' : 'var(--text-secondary)'}
                  fontSize={9.5}
                  fontWeight={isHovered ? '700' : '500'}
                  className="select-none"
                >
                  #{pt.publicationOrder}
                </text>
              </g>
            );
          })}

          {/* 7. Floating Tooltip Overlay inside SVG */}
          {activeHover ? (
            <g
              transform={`translate(${
                activeHover.x > padL + plotWidth - 160 ? activeHover.x - 170 : activeHover.x + 12
              }, ${
                activeHover.y < padT + 80 ? activeHover.y + 12 : activeHover.y - 75
              })`}
            >
              <rect
                width={160}
                height={68}
                rx={8}
                fill="var(--surface-accent)"
                stroke="var(--border-control)"
                strokeWidth={1}
                style={{ filter: 'drop-shadow(0 6px 16px rgba(0,0,0,0.45))' }}
              />
              <text x={10} y={18} fill="var(--text-primary)" fontSize={11} fontWeight="700">
                {activeHover.tournamentName}
              </text>
              <text x={10} y={34} fill={getRankColor(activeHover.newRating)} fontSize={12} fontWeight="800">
                Rating: {activeHover.newRating}
                {activeHover.delta !== null ? (
                  <tspan
                    fill={activeHover.delta >= 0 ? 'var(--success-text)' : 'var(--danger-text)'}
                    fontSize={10}
                    fontWeight="600"
                    dx={6}
                  >
                    ({activeHover.delta >= 0 ? `+${activeHover.delta}` : activeHover.delta})
                  </tspan>
                ) : null}
              </text>
              <text x={10} y={50} fill="var(--text-secondary)" fontSize={9.5}>
                Đợt công bố #{activeHover.publicationOrder}
              </text>
              <text x={10} y={62} fill="var(--text-faint)" fontSize={8.5}>
                Bậc: {activeHover.rankName}
              </text>
            </g>
          ) : null}
        </svg>
      </div>

      {/* Accessible Full Data Breakdown Table */}
      <details className="mt-4 border-t border-[var(--border-subtle)] pt-3 text-xs font-mono">
        <summary className="cursor-pointer font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
          Xem bảng số liệu chi tiết từng giải ({chartPoints.length} lượt công bố) ↓
        </summary>
        <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
          <table className="w-full text-left border-collapse">
            <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)] uppercase text-[10px] tracking-wider">
              <tr>
                <th scope="col" className="p-2.5">Đợt</th>
                <th scope="col" className="p-2.5">Giải đấu</th>
                <th scope="col" className="p-2.5 text-right">Rating</th>
                <th scope="col" className="p-2.5 text-right">Biến động (Δ)</th>
                <th scope="col" className="p-2.5">Bậc xếp hạng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {chartPoints.map((pt) => (
                <tr key={pt.publicationOrder} className="hover:bg-[var(--surface)] transition-colors">
                  <td className="p-2.5 font-bold tabular-nums">#{pt.publicationOrder}</td>
                  <td className="p-2.5 font-semibold text-[var(--text-primary)]">{pt.tournamentName}</td>
                  <td className="p-2.5 text-right font-bold tabular-nums" style={{ color: getRankColor(pt.newRating) }}>
                    {pt.newRating}
                  </td>
                  <td className="p-2.5 text-right font-semibold tabular-nums">
                    {pt.delta !== null ? (
                      <span className={pt.delta >= 0 ? 'text-[var(--success-text)]' : 'text-[var(--danger-text)]'}>
                        {pt.delta >= 0 ? `+${pt.delta}` : pt.delta}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2.5 text-[var(--text-secondary)]">{pt.rankName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
