import { useEffect, useState } from 'react'

// 航班資訊頁面: 仿生圖功能。左側 drawer 選航線(AuthGate 負責), 此處依選中航線
//   以「月」為單位向 FlyTicketAPI /flights 抓取該月航班, 排成「時段×日期」表格。
//   時段為固定區間(07-09 ... 19-24), 航班依出發時間歸入對應時段格。
//   同格多班只顯示一個狀態圈(綠=立榮有位, 藍=華信有位, 綠包藍=兩家都有, 紅✕=無空位)。
//   點選時段格 → 底部彈出該時段全部航班明細。上/下月按鈕切換月份。
const FLIGHTS = '/flights-api'

function pad2(n) { return String(n).padStart(2, '0') }

// 固定時段區間(單位: 小時)。出發時間依小時歸入對應區間。
const TIME_BUCKETS = [
  { label: '07-09', start: 7, end: 9 },
  { label: '09-11', start: 9, end: 11 },
  { label: '11-13', start: 11, end: 13 },
  { label: '13-15', start: 13, end: 15 },
  { label: '15-17', start: 15, end: 17 },
  { label: '17-19', start: 17, end: 19 },
  { label: '19-24', start: 19, end: 24 },
]

function bucketIndex(timeStr) {
  const h = parseInt(String(timeStr).split(':')[0], 10)
  if (isNaN(h)) return 0
  for (let i = 0; i < TIME_BUCKETS.length; i++) {
    if (h >= TIME_BUCKETS[i].start && h < TIME_BUCKETS[i].end) return i
  }
  if (h < TIME_BUCKETS[0].start) return 0
  return TIME_BUCKETS.length - 1
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 860px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 860px)')
    const on = (e) => setMobile(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}

export default function FlightBoard({ route }) {
  const now = new Date()
  const todayStr = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 }) // m: 1..12
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const isMobile = useIsMobile()
  const [showAll, setShowAll] = useState(() => !window.matchMedia('(max-width: 860px)').matches)
  const [sel, setSel] = useState(null) // { date, bucket }

  const dep = route?.dep
  const arr = route?.arr

  useEffect(() => {
    if (!dep || !arr) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setError('')
    setSel(null)
    const lastDay = new Date(ym.y, ym.m, 0).getDate()
    const start = `${ym.y}-${pad2(ym.m)}-01`
    const end = `${ym.y}-${pad2(ym.m)}-${pad2(lastDay)}`
    const url = FLIGHTS + '/flights?dep=' + encodeURIComponent(dep) + '&arr=' + encodeURIComponent(arr) + '&start=' + start + '&end=' + end + '&airline=all'
    fetch(url)
      .then((r) => r.json().catch(() => ({})).then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return
        if (!ok || !d.ok) { setError(d.error || ('抓取失敗 (HTTP ' + (d.httpStatus || '?') + ')')); setData(null) }
        else setData(d)
      })
      .catch((e) => { if (!cancelled) setError('抓取失敗: ' + e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dep, arr, ym.y, ym.m])

  function prevMonth() { setYm((p) => (p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 })) }
  function nextMonth() { setYm((p) => (p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 })) }
  function goThisMonth() { setYm({ y: now.getFullYear(), m: now.getMonth() + 1 }) }

  const lastDay = new Date(ym.y, ym.m, 0).getDate()
  const flights = data?.['航班'] || []
  const lastUpdate = flights.reduce((m, f) => (f['更新時間'] && f['更新時間'] > m ? f['更新時間'] : m), '')

  // 彙整: 依時段區間做直欄, 依日期做列。同(日期,時段)若有多班, 合併成一個狀態圈。
  const cell = {} // key 日期|bucketIdx -> [航班]
  const dayHas = {} // 日期 -> 有航班
  for (const f of flights) {
    const key = f['日期'] + '|' + bucketIndex(f['出發時間'])
    ;(cell[key] || (cell[key] = [])).push(f)
    dayHas[f['日期']] = true
  }

  const selList = sel
    ? (cell[sel.date + '|' + sel.bucket] || []).slice().sort((a, b) => String(a['出發時間']).localeCompare(String(b['出發時間'])))
    : []

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>{route ? (route.出發 + ' 往 ' + route.目的地 + ' （' + ym.y + ' 年' + ym.m + '月）') : '請選擇航線'}</strong>
        </header>

        <div className="flt-nav">
          <button className="flt-nav-btn" onClick={prevMonth} aria-label="上個月" title="上個月">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button className="flt-nav-btn flt-nav-today" onClick={goThisMonth} aria-label="本月" title="本月">本月</button>
          <button className="flt-nav-btn" onClick={nextMonth} aria-label="下個月" title="下個月">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          <label className="flt-toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            顯示全部日期
          </label>
        </div>

        <div className="flt-legend">
          <span className="flt-legend-item"><span className="flt-dot" />立榮有位</span>
          <span className="flt-legend-item"><span className="flt-dot flt-dot-blue" />華信有位</span>
          <span className="flt-legend-item"><span className="flt-dot-both"><span className="flt-dot-both-inner" /></span>兩家都有</span>
          <span className="flt-legend-item"><span className="flt-cross">✕</span>無空位</span>
        </div>

        {loading && <div className="flt-hint">載入中…</div>}
        {error && <p className="flt-error">{error}</p>}

        {!loading && !error && route && (
          flights.length === 0 ? (
            <div className="flt-hint">本月無航班資料。</div>
          ) : (
            <>
              <div className="flt-table-wrap">
                <table className="flt-table">
                  <thead>
                    <tr>
                      <th className="flt-day-head">日期</th>
                      {TIME_BUCKETS.map((b) => (<th key={b.label} className="flt-time-head">{b.label}</th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: lastDay }, (_, i) => i + 1)
                      .filter((day) => showAll || dayHas[ym.y + '-' + pad2(ym.m) + '-' + pad2(day)])
                      .map((day) => {
                        const dateStr = ym.y + '-' + pad2(ym.m) + '-' + pad2(day)
                        const isToday = dateStr === todayStr
                        return (
                          <tr key={day} className={isToday ? 'flt-row-today' : ''}>
                            <th className="flt-day">{ym.m}/{day}{isToday ? ' ·今' : ''}</th>
                            {TIME_BUCKETS.map((b, bi) => {
                              const list = cell[dateStr + '|' + bi]
                              let cls = 'flt-cell-empty', mark = ''
                              if (list) {
                                const n = list.length
                                const cnt = n > 1 ? <span className="flt-dot-num">{n}</span> : null
                                const okUni = list.some((f) => f['航空公司'] === '立榮航空' && f['有無空位'] === '有')
                                const okMan = list.some((f) => f['航空公司'] === '華信航空' && f['有無空位'] === '有')
                                const ok = okUni || okMan
                                cls = ok ? 'flt-cell-ok' : 'flt-cell-no'
                                if (okUni && okMan) mark = <span className="flt-dot-both"><span className="flt-dot-both-inner" />{n > 1 ? <span className="flt-dot-both-num">{n}</span> : null}</span>
                                else if (okUni) mark = <span className="flt-dot">{cnt}</span>
                                else if (okMan) mark = <span className="flt-dot flt-dot-blue">{cnt}</span>
                                else mark = <span className="flt-cross">✕</span>
                              }
                              const active = sel && sel.date === dateStr && sel.bucket === bi
                              return (
                                <td
                                  key={b.label}
                                  className={'flt-cell ' + cls + (list ? ' flt-cell-btn' : '') + (active ? ' flt-cell-active' : '')}
                                  onClick={list ? () => setSel({ date: dateStr, bucket: bi }) : undefined}
                                >{mark}</td>
                              )
                            })}
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
              <div className="flt-meta">
                共 {data['總筆數'] ?? flights.length} 班{lastUpdate ? ' · 最後更新：' + lastUpdate : ''}
              </div>
            </>
          )
        )}
      </section>

      {sel && (
        <>
          <div className="flt-detail-backdrop" onClick={() => setSel(null)} />
          <div className="flt-detail" role="dialog" aria-label="航班明細">
            <div className="flt-detail-head">
              <strong>{sel.date} {TIME_BUCKETS[sel.bucket].label}</strong>
              <button className="flt-detail-close" onClick={() => setSel(null)} aria-label="關閉">✕</button>
            </div>
            <div className="flt-detail-body">
              {selList.map((f, i) => (
                <div key={i} className={'flt-detail-row ' + (f['有無空位'] === '有' ? 'is-ok' : 'is-no')}>
                  <div className="flt-detail-airline">{f['航空公司']}</div>
                  <div className="flt-detail-main">
                    <span className="flt-detail-no">{f['航班編號']}</span>
                    <span className="flt-detail-time">{f['出發時間']} → {f['抵達時間']}</span>
                    <span className="flt-detail-craft">{f['機型']}</span>
                    {f['更新時間'] ? <span className="flt-detail-updated">更新 {f['更新時間']}</span> : null}
                  </div>
                  <div className="flt-detail-seats">
                    {f['有無空位'] === '有'
                      ? <span className="flt-dot" />
                      : <span className="flt-cross">✕</span>}
                    {f['備註'] ? <span className="flt-detail-note">{f['備註']}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
