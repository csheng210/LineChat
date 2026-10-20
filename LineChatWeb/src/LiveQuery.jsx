// 即時查詢(獨立頁面): 出發/回程航線(僅列澎湖航班.json 的澎湖航線)+日期+人數,
//   按「搜尋」後對 FlyTicketAPI /flights-online 並行即時抓取, 結果以置中 popup 呈現,
//   來程(dep→arr)與回程(arr→dep)分兩區並標明方向。選來程航線時回程自動反選(松山往澎湖 -> 澎湖往松山)。
import { useEffect, useMemo, useRef, useState } from 'react'

const FLIGHTS = '/flights-api'
const pad2 = (n) => String(n).padStart(2, '0')

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

// 三天兩夜: 出發日期 + 2 天 = 回程日期
function addDaysStr(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate())
}

// 航班列: 沿用航班明細(flt-detail-row)樣式
function FlightRow({ f }) {
  return (
    <div className={'flt-detail-row ' + (f['有無空位'] === '有' ? 'is-ok' : 'is-no')}>
      <div className={'flt-detail-airline ' + (f['航空公司'] === '立榮航空' ? 'lq-air-uniair' : 'lq-air-mandarin')}>{f['航空公司']}</div>
      <div className="flt-detail-main">
        <span className="flt-detail-no">{f['航班編號']}</span>
        <span className="flt-detail-time">{f['出發時間']} → {f['抵達時間']}</span>
        <span className="flt-detail-craft">{f['機型']}</span>
      </div>
      <div className="flt-detail-seats">
        {f['有無空位'] === '有' ? <span className="flt-dot" /> : <span className="flt-cross">✕</span>}
        {f['備註'] ? <span className="flt-detail-note">{f['備註']}</span> : null}
      </div>
    </div>
  )
}

function Leg({ title, tone, res, err }) {
  const list = (res?.['航班'] || []).slice().sort((a, b) =>
    String(a['日期']).localeCompare(String(b['日期'])) || String(a['出發時間']).localeCompare(String(b['出發時間'])))
  return (
    <section className="lq-leg">
      <div className="lq-leg-head">
        <span className={'lq-leg-tag ' + tone}>{title}</span>
        {res && (
          <span className="lq-leg-meta">
            {res['航線']} · {res['日期範圍'].start} · {res['總筆數']} 班
            {res['耗時秒'] != null ? ' · ' + res['耗時秒'] + '秒' : ''}
          </span>
        )}
      </div>
      {err && <div className="lq-leg-err">{err}</div>}
      {res && !err && list.length === 0 && <div className="lq-leg-empty">查無航班（可能無營運航線或當日無航班）</div>}
      {res && !err && list.map((f, i) => <FlightRow key={i} f={f} />)}
    </section>
  )
}

// ---- 模組層查詢狀態: 元件卸載(切頁)時背景輪詢繼續, 重返頁面可續看進度與結果 ----
const store = {
  running: false, cancelling: false, cancelled: false,
  jobs: [],      // [{ jobId, tone: 'out'|'ret' }] 順序=來程,回程
  prog: {},      // jobId -> { done, total } 天進度
  res: null, msg: '',
  params: null,  // 表單快照, 重返頁面時還原
  listeners: new Set(),
}
const emit = () => store.listeners.forEach((fn) => fn())
const snapshot = () => ({
  running: store.running, cancelling: store.cancelling,
  prog: { ...store.prog }, res: store.res, msg: store.msg,
})

function qUrl(d, a, dt, pax) {
  return FLIGHTS + '/flights-online/start?dep=' + encodeURIComponent(d)
    + '&arr=' + encodeURIComponent(a) + '&start=' + dt + '&end=' + dt
    + '&airline=all&pax=' + Math.max(1, Math.min(9, Number(pax) || 4))
}

async function startJob(url) {
  const r = await fetch(url)
  const d = await r.json().catch(() => ({}))
  if (!r.ok || !d.ok) throw new Error(d['訊息'] || ('啟動失敗 (HTTP ' + r.status + ')'))
  return d.jobId
}

async function pollJob(jobId) {
  const t0 = Date.now()
  for (;;) {
    if (store.cancelled) throw new Error('已中止')
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('查詢逾時(15 分鐘)')
    const r = await fetch(FLIGHTS + '/flights-online/status?jobId=' + encodeURIComponent(jobId))
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.ok) throw new Error(d['訊息'] || ('輪詢失敗 (HTTP ' + r.status + ')'))
    store.prog[jobId] = { done: d['天進度'], total: d['天總數'] }
    emit()
    if (d['完成']) {
      if (d.status === 'error') throw new Error(d['訊息'] || '抓取失敗')
      const okAll = d['失敗數'] === 0
      return {
        航線: d['航線'], 日期範圍: d['日期範圍'], 總筆數: d['總筆數'], 耗時秒: d['耗時秒'],
        航班: d['航班'] || [],
        ...(okAll ? {} : { 訊息: '部分業者抓取失敗: ' + (d['訊息'] || (d['結果'] || []).filter((x) => !x.ok).map((x) => x['訊息']).join(' | ')) }),
      }
    }
    await new Promise((ok) => setTimeout(ok, 1500))
  }
}

// 背景執行(來程+回程兩個 job): 與元件生命週期脫鉤, 切頁卸載後仍持續輪詢並寫入 store
async function runJobs(p) {
  let ids = []
  try {
    ids = [await startJob(qUrl(p.depOut, p.arrOut, p.outDate, p.pax)),
      await startJob(qUrl(p.depRet, p.arrRet, p.retDate, p.pax))]
    store.jobs = [{ jobId: ids[0], tone: 'out' }, { jobId: ids[1], tone: 'ret' }]
    emit()
  } catch (e) {
    store.res = { out: null, outErr: e.message, ret: null, retErr: e.message, labelOut: p.labelOut, labelRet: p.labelRet }
    store.running = false; store.jobs = []; emit(); return
  }
  const [o, rt] = await Promise.allSettled(ids.map((id) => pollJob(id)))
  if (store.cancelled) {
    store.running = false; store.cancelling = false; store.jobs = []; store.prog = {}; emit(); return
  }
  store.res = {
    out: o.status === 'fulfilled' ? o.value : null,
    outErr: o.status === 'fulfilled' ? '' : (o.reason?.message || '來程查詢失敗'),
    ret: rt.status === 'fulfilled' ? rt.value : null,
    retErr: rt.status === 'fulfilled' ? '' : (rt.reason?.message || '回程查詢失敗'),
    labelOut: p.labelOut, labelRet: p.labelRet,
  }
  store.running = false; store.cancelling = false; store.jobs = []; emit()
}

export default function LiveQuery({ routes, defaultRoute }) {
  // 只聚焦澎湖航線: 來程 = X 往 澎湖, 回程 = 澎湖 往 X
  const outOpts = useMemo(() => routes.filter((r) => r['目的地'] === '澎湖'), [routes])
  const retOpts = useMemo(() => routes.filter((r) => r['出發'] === '澎湖'), [routes])
  const keyOf = (r) => r.dep + '>' + r.arr
  const initOut = outOpts.find((r) => defaultRoute && keyOf(r) === keyOf(defaultRoute)) || outOpts[0] || null
  const saved = store.params // 切頁卸載後重返: 還原表單與進行中的查詢
  const [outKey, setOutKey] = useState(saved?.outKey ?? (initOut ? keyOf(initOut) : ''))
  const [outDate, setOutDate] = useState(saved?.outDate ?? todayStr())
  const [retDate, setRetDate] = useState(saved?.retDate ?? addDaysStr(todayStr(), 2))
  const [retKey, setRetKey] = useState(() => {
    if (saved?.retKey) return saved.retKey
    if (!initOut) return ''
    const rev = retOpts.find((r) => r.dep === initOut.arr && r.arr === initOut.dep)
    return rev ? keyOf(rev) : ''
  })
  const [pax, setPax] = useState(saved?.pax ?? 4)
  const [snap, setSnap] = useState(snapshot)
  const restoredRef = useRef(!!saved) // 重返時跳過一次自動反選, 保留原回程航線

  const busy = snap.running
  const cancelling = snap.cancelling
  const prog = snap.prog
  const res = snap.res
  const msg = snap.msg

  // 訂閱模組層 store: 卸載只退訂, 不中斷背景輪詢
  useEffect(() => {
    const fn = () => setSnap(snapshot())
    store.listeners.add(fn)
    fn()
    return () => { store.listeners.delete(fn) }
  }, [])

  // 來程航線變動 -> 回程自動反選(澎湖往同一城市)
  useEffect(() => {
    if (restoredRef.current) { restoredRef.current = false; return }
    const o = outOpts.find((r) => keyOf(r) === outKey)
    if (!o) return
    const rev = retOpts.find((r) => r.dep === o.arr && r.arr === o.dep)
    setRetKey(rev ? keyOf(rev) : '')
  }, [outKey, outOpts, retOpts])

  const outRoute = outOpts.find((r) => keyOf(r) === outKey)
  const retRoute = retOpts.find((r) => keyOf(r) === retKey)

  const legProg = () => {
    const parts = []
    for (const j of store.jobs) {
      const v = prog[j.jobId]
      if (v) parts.push((j.tone === 'out' ? '來' : '回') + v.done + '/' + v.total + '天')
    }
    return parts.join(' ')
  }

  function run() {
    if (store.running) return
    if (!outRoute || !retRoute) { store.msg = '請選擇出發與回程航線'; emit(); return }
    if (!outDate || !retDate) { store.msg = '請選擇出發與回程日期'; emit(); return }
    const p = {
      depOut: outRoute.dep, arrOut: outRoute.arr, depRet: retRoute.dep, arrRet: retRoute.arr,
      outDate, retDate, pax, outKey, retKey,
      labelOut: outRoute['出發'] + ' 往 ' + outRoute['目的地'] + ' ' + outDate,
      labelRet: retRoute['出發'] + ' 往 ' + retRoute['目的地'] + ' ' + retDate,
    }
    store.running = true; store.cancelled = false; store.cancelling = false
    store.res = null; store.msg = ''; store.prog = {}; store.jobs = []; store.params = p
    emit()
    runJobs(p) // 不 await: 背景跑, 切頁也不影響
  }

  // 停止: 殺後端進行中的抓取程序並中止輪詢
  function stop() {
    if (!store.running || store.cancelling) return
    store.cancelling = true; store.cancelled = true; emit()
    for (const j of store.jobs) fetch(FLIGHTS + '/flights-online/cancel?jobId=' + encodeURIComponent(j.jobId)).catch(() => {})
  }

  const closeRes = () => { store.res = null; emit() }

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>即時查詢</strong>
          <span className="gen-main-sub">即時抓取航空公司網頁航班（來程+回程）</span>
        </header>
        <div className="lq-form">
          <label>出發航線
            <select value={outKey} onChange={(e) => setOutKey(e.target.value)} disabled={busy}>
              {outOpts.length === 0 && <option value="">無可用航線</option>}
              {outOpts.map((r) => <option key={keyOf(r)} value={keyOf(r)}>{r['出發']} 往 {r['目的地']}</option>)}
            </select>
          </label>
          <label>出發日期
            <input type="date" value={outDate} onChange={(e) => { setOutDate(e.target.value); if (e.target.value) setRetDate(addDaysStr(e.target.value, 2)) }} disabled={busy} />
          </label>
          <label>回程航線
            <select value={retKey} onChange={(e) => setRetKey(e.target.value)} disabled={busy}>
              {retOpts.length === 0 && <option value="">無可用航線</option>}
              {retOpts.map((r) => <option key={keyOf(r)} value={keyOf(r)}>{r['出發']} 往 {r['目的地']}</option>)}
            </select>
          </label>
          <label>回程日期
            <input type="date" value={retDate} onChange={(e) => setRetDate(e.target.value)} disabled={busy} />
          </label>
          <label>人數
            <input type="number" min="1" max="9" value={pax} onChange={(e) => setPax(e.target.value)} disabled={busy} />
          </label>
          <div className="lq-btns">
            <button className="lq-run" onClick={run} disabled={busy || !outRoute || !retRoute}>
              {busy ? '即時抓取中… ' + legProg() : '搜尋'}
            </button>
            {busy && <button className="lq-run lq-stop" onClick={stop} disabled={cancelling}>{cancelling ? '停止中…' : '停止'}</button>}
          </div>
        </div>
        {msg && <div className="lq-msg">{msg}</div>}
      </section>

      {res && (
        <>
          <div className="lq-backdrop" onClick={closeRes} />
          <div className="lq-modal" role="dialog" aria-label="即時查詢結果">
            <div className="lq-head">
              <strong>即時查詢結果</strong>
              <button className="flt-detail-close" onClick={closeRes} aria-label="關閉">✕</button>
            </div>
            <div className="lq-results">
              <Leg title={'來程 ' + res.labelOut} tone="lq-tone-out" res={res.out} err={res.outErr} />
              <Leg title={'回程 ' + res.labelRet} tone="lq-tone-ret" res={res.ret} err={res.retErr} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
