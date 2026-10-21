import { useEffect, useState } from 'react'

// 澎湖航班票價頁面: 讀取 FlyTicketAPI /penghu (澎湖航班.json 原始內容),
//   依航空公司條列各航線的去程/回程/往返票價(全額/敬老/兒童/愛心/愛心陪同), 以表格呈現。
const FLIGHTS = '/flights-api'

// 票種欄位順序
const PRICES = ['全額', '敬老', '兒童', '愛心', '愛心陪同']
// 城市顯示順序(與航線 drawer 一致)
const CITY_ORDER = ['TSA', 'RMQ', 'KHH', 'TNN', 'CYI']

function fmt(n) {
  const v = Number(n)
  return isFinite(v) ? v.toLocaleString('zh-TW') : '—'
}

// 由某航空業者的 { 出發澎湖, 抵達澎湖 } 組出航線票價列(去/回/往返)
function buildRows(airlineName, block) {
  const outMap = {} // 城市碼 -> 澎湖→城市
  for (const r of (block['出發澎湖'] || [])) if (r['出發碼'] === 'MZG') outMap[r['目的地碼']] = r
  const backMap = {} // 城市碼 -> 城市→澎湖
  for (const r of (block['抵達澎湖'] || [])) if (r['目的地碼'] === 'MZG') backMap[r['出發碼']] = r
  const codes = []
  for (const c of CITY_ORDER) if (outMap[c] || backMap[c]) codes.push(c)
  for (const c of Object.keys(outMap)) if (!codes.includes(c)) codes.push(c)
  for (const c of Object.keys(backMap)) if (!codes.includes(c)) codes.push(c)
  const rows = []
  for (const c of codes) {
    const out = outMap[c] // 澎湖 往 城市
    const back = backMap[c] // 城市 往 澎湖
    const city = (back && back['出發']) || (out && out['目的地']) || c
    if (back) rows.push({ 航空公司: airlineName, 航線: city + ' 往 澎湖', 票: back['票種價格'] || {}, 碼: c + '→MZG' })
    if (out) rows.push({ 航空公司: airlineName, 航線: '澎湖 往 ' + city, 票: out['票種價格'] || {}, 碼: 'MZG→' + c })
    if (out && back) {
      const sum = {}
      for (const p of PRICES) {
        const a = Number(out['票種價格'] && out['票種價格'][p])
        const b = Number(back['票種價格'] && back['票種價格'][p])
        sum[p] = isFinite(a) && isFinite(b) ? a + b : ''
      }
      rows.push({ 航空公司: airlineName, 航線: city + ' 往返 澎湖', 票: sum, 碼: c + '↔MZG', round: true })
    }
  }
  return rows
}

export default function FlightPrices() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(FLIGHTS + '/penghu')
      .then(async (r) => { const d = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, d } })
      .then(({ ok, status, d }) => {
        if (cancelled) return
        if (!ok) {
          const hint = (status === 502 || status === 503 || status === 504)
            ? '航班後端 (FlyTicketAPI) 未啟動，請執行 Start-LineChat 啟動航班服務'
            : (d.訊息 || d.error || ('讀取失敗 (HTTP ' + status + ')'))
          setError(hint); setData(null)
        } else setData(d)
      })
      .catch((e) => { if (!cancelled) setError('讀取失敗: ' + e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const airlines = data ? Object.keys(data).filter((k) => data[k] && (data[k]['出發澎湖'] || data[k]['抵達澎湖'])) : []
  const allRows = []
  for (const name of airlines) allRows.push(...buildRows(name, data[name]))
  const 探測日期 = data && data['探測日期']
  const 票價更新 = data && data['票種價格更新時間']

  return (
    <div className="gen-page">
      <section className="gen-main">
        <header className="gen-main-header">
          <strong>澎湖航班票價</strong>
          <span className="gen-main-desc">{探測日期 ? '探測日期 ' + 探測日期 : ''}{票價更新 ? ' · 票價更新 ' + 票價更新 : ''}</span>
        </header>

        {loading && <div className="flt-hint">載入中…</div>}
        {error && <p className="flt-error">{error}</p>}

        {!loading && !error && (
          allRows.length === 0 ? (
            <div className="flt-hint">無票價資料。</div>
          ) : (
            <>
              <div className="flt-table-wrap">
                <table className="flt-price-table">
                  <thead>
                    <tr>
                      <th className="flt-price-air">航空公司</th>
                      <th className="flt-price-route">航線</th>
                      {PRICES.map((p) => (<th key={p}>{p}</th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {allRows.map((r, i) => (
                      <tr key={i} className={r.round ? 'flt-price-round' : ''}>
                        <td className="flt-price-air">{r.航空公司}</td>
                        <td className="flt-price-route">{r.航線}<span className="flt-price-code">{r.碼}</span></td>
                        {PRICES.map((p) => (<td key={p} className="flt-price-num">{fmt(r.票[p])}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flt-meta">單位: 新台幣(NT$) · 往返為去程＋回程票價合計</div>
            </>
          )
        )}
      </section>
    </div>
  )
}