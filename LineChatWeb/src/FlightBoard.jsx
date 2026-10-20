import { useEffect, useState, useSyncExternalStore } from 'react'
import { EMPTY_JOB, getSnapshot, startSync, stopSync, subscribe } from './flightSyncStore.js'

// 航班資訊頁面: 仿生圖功能。左側 drawer 選航線(AuthGate 負責), 此處依選中航線
//   以「月」為單位向 FlyTicketAPI /flights 抓取該月航班, 排成「時段×日期」表格。
//   時段為固定區間(07-09 ... 19-24), 航班依出發時間歸入對應時段格。
//   同格多班只顯示一個狀態圈(綠=立榮有位, 藍=華信有位, 綠包藍=兩家都有, 紅✕=無空位)。
//   點選時段格 → 底部彈出該時段全部航班明細。上/下月按鈕切換月份。
const FLIGHTS = '/flights-api'

function pad2(n) { return String(n).padStart(2, '0') }

// 星期字(索引對應 Date.getDay(): 0=日 ... 6=六), 日期欄顯示用
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

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
  const [sel, setSel] = useState(null) // { date, bucket }
  const [selDay, setSelDay] = useState(null) // 點選日期欄: 該日全部航班(依出發時間排序)
  const snap = useSyncExternalStore(subscribe, getSnapshot) // 同步任務狀態(store 層, 切頁再回來仍接得回)

  const dep = route?.dep
  const arr = route?.arr
  const syncKey = dep && arr ? dep + '|' + arr : ''
  const job = (syncKey && snap.jobs[syncKey]) || EMPTY_JOB
  const syncing = job.busy
  const cancelling = job.cancelling
  const syncMsg = job.msg

  useEffect(() => {
    if (!dep || !arr) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setError('')
    setSel(null)
    setSelDay(null)
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
  }, [dep, arr, ym.y, ym.m, snap.reload])

  function prevMonth() { setYm((p) => (p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 })) }
  function nextMonth() { setYm((p) => (p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 })) }
  function goThisMonth() { setYm({ y: now.getFullYear(), m: now.getMonth() + 1 }) }

  // 同步本月該航線: 任務與輪詢都在 flightSyncStore(模組層級),
  //   切到首頁/生圖再切回來仍看得到同一任務的進度; 完成時 store 會 bump reload 觸發重抓資料。
  function doSync() { startSync(syncKey, { dep, arr, y: ym }) }
  function doStopSync() { stopSync(syncKey) }

  const lastDay = new Date(ym.y, ym.m, 0).getDate()
  const flights = data?.['航班'] || []
  const lastUpdate = flights.reduce((m, f) => (f['更新時間'] && f['更新時間'] > m ? f['更新時間'] : m), '')

  // 彙整: 依時段區間做直欄, 依日期做列。同(日期,時段)若有多班, 合併成一個狀態圈。
  const cell = {} // key 日期|bucketIdx -> [航班]
  for (const f of flights) {
    const key = f['日期'] + '|' + bucketIndex(f['出發時間'])
    ;(cell[key] || (cell[key] = [])).push(f)
  }

  const byTime = (a, b) => String(a['出發時間']).localeCompare(String(b['出發時間']))
  const selList = sel
    ? (cell[sel.date + '|' + sel.bucket] || []).slice().sort(byTime)
    : []
  const dayList = selDay
    ? flights.filter((f) => f['日期'] === selDay).slice().sort(byTime)
    : []

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>{route ? (route.出發 + ' 往 ' + route.目的地 + ' （' + ym.y + ' 年' + ym.m + '月）') : '請選擇航線'}</strong>
          {route && (
            <div className="flt-sync-wrap">
              <div className="flt-sync-row">
                {syncing ? (
                  <button className="flt-sync-btn flt-sync-stop" onClick={doStopSync} disabled={cancelling} title="停止同步">
                    {cancelling ? '停止中…' : '停止'}
                  </button>
                ) : (
                  <button className="flt-sync-btn" onClick={doSync} title="同步本月航班">同步</button>
                )}
              </div>
              {syncing && (
                <div className="flt-sync-progress">
                  <div className="flt-sync-bar">
                    <div className="flt-sync-bar-fill" style={{ width: (job.dayTotal > 0 ? Math.round(job.dayDone / job.dayTotal * 100) : 0) + '%' }} />
                    {job.dayTotal > 1 && (
                      <div
                        className="flt-sync-bar-ticks"
                        title={'航線 ' + job.done + '/' + job.total}
                        style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent 0, transparent calc(' + (100 / job.dayTotal) + '% - 1px), rgba(255,255,255,0.7) calc(' + (100 / job.dayTotal) + '% - 1px), rgba(255,255,255,0.7) calc(' + (100 / job.dayTotal) + '%))' }}
                      />
                    )}
                  </div>
                  <span className="flt-sync-prog-text" title={'航線 ' + job.done + '/' + job.total}>{job.dayDone}/{job.dayTotal} 天</span>
                </div>
              )}
              <span className="flt-sync-time">{lastUpdate ? '最後同步：' + lastUpdate : '尚未同步'}</span>
            </div>
          )}
        </header>

        <div className="flt-nav">
          <button className="flt-nav-btn" onClick={prevMonth} aria-label="上個月" title="上個月">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button className="flt-nav-btn flt-nav-today" onClick={goThisMonth} aria-label="本月" title="本月">本月</button>
          <button className="flt-nav-btn" onClick={nextMonth} aria-label="下個月" title="下個月">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>
          {syncMsg && <span className="flt-sync-msg">{syncMsg}</span>}
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
                      .map((day) => {
                        const dateStr = ym.y + '-' + pad2(ym.m) + '-' + pad2(day)
                        const isToday = dateStr === todayStr
                        const dow = new Date(ym.y, ym.m - 1, day).getDay() // 0=週日, 6=週六
                        const isWeekend = dow === 0 || dow === 6
                        return (
                          <tr key={day} className={isToday ? 'flt-row-today' : ''}>
                            <th
                              className={'flt-day flt-day-btn' + (isWeekend ? ' flt-day-weekend' : '') + (selDay === dateStr ? ' flt-day-active' : '')}
                              onClick={() => setSelDay(dateStr)}
                              role="button"
                              title="查看當日全部航班"
                            >{ym.m}/{day}（{WEEKDAY[dow]}）</th>
                            {TIME_BUCKETS.map((b, bi) => {
                              const list = cell[dateStr + '|' + bi]
                              let cls = 'flt-cell-empty', mark = ''
                              if (list) {
                                const n = list.filter((f) => f['有無空位'] === '有').length
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

      {(sel || selDay) && (
        <>
          <div className="flt-detail-backdrop" onClick={() => { setSel(null); setSelDay(null) }} />
          <div className="flt-detail" role="dialog" aria-label="航班明細">
            <div className="flt-detail-head">
              <strong>{sel ? sel.date + ' ' + TIME_BUCKETS[sel.bucket].label : selDay + ' 全日航班'}</strong>
              <button className="flt-detail-close" onClick={() => { setSel(null); setSelDay(null) }} aria-label="關閉">✕</button>
            </div>
            <div className="flt-detail-body">
              {(sel ? selList : dayList).map((f, i) => (
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
