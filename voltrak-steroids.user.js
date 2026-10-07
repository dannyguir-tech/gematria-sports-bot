// ==UserScript==
// @name         VolTrak Steroids
// @namespace    voltrak-alert
// @version      3.0.0
// @description  VolTrak context + GMGN handoff + free DEX snapshots. Analysis only; never submits trades.
// @match        https://discord.com/channels/*
// @match        https://gmgn.ai/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      api.dexscreener.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

/* CORE START — pure functions, also used by offline regression tests. */
const VTCore = (() => {
  'use strict';
  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const number = v => v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null;
  function money(v) {
    const m = String(v || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)\s*([KMB])?/i);
    return m ? +m[1] * ({K: 1e3, M: 1e6, B: 1e9}[(m[2] || '').toUpperCase()] || 1) : null;
  }
  function parseAlert(text) {
    const title = text.match(/^\s*([^\n]+?)\s*\(\$([^\n)]+)\)\s*$/m);
    if (!title) return null;
    const tail = text.slice(title.index + title[0].length);
    const ca = tail.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    if (!ca) return null;
    const mc = tail.match(/(?:^|\n)\s*MC\s*\n\s*(\$[\d.,]+[KMB]?)/i);
    const age = tail.match(/(?:^|\n)\s*Age\s*\n\s*(\d+(?:\.\d+)?)\s*([smhd])/i);
    const bond = tail.match(/(?:^|\n)\s*Bonding Curve\s*\n\s*([^\n]+)/i);
    const volume = tail.match(/(?:^|\n)\s*Volume\s*\(5M\)\s*\n\s*([^\n]+)/i);
    const holder = tail.match(/#1 holder:\s*([\d.]+)%/i);
    const clusters = Array.from(tail.matchAll(/Cluster\s+\d+\s*:\s*([\d.]+)%/gi), m => +m[1]);
    const count = label => { const m = tail.match(new RegExp(label + ':\\s*([\\d,]+)', 'i')); return m ? +m[1].replace(/,/g, '') : null; };
    const migrated = bond ? /not\s+migrated/i.test(bond[1]) ? false : /migrated/i.test(bond[1]) ? true : null : null;
    return {mint: ca[0], name: title[1].trim(), symbol: title[2].trim(), callMc: mc ? money(mc[1]) : null,
      ageSeconds: age ? +age[1] * ({s:1,m:60,h:3600,d:86400}[age[2].toLowerCase()]) : null,
      migrated, volume5m: volume && /\$/.test(volume[1]) ? money(volume[1]) : null,
      partialVolume: !!(volume && /since launch|younger/i.test(volume[1])),
      conflict: !!(migrated === true && volume && /still on bonding curve/i.test(volume[1])),
      topHolder: holder ? +holder[1] : null, clusters,
      holders: count('Total Holders'), experienced: count('Experienced Traders'),
      bots: count('Bots/High-Risk'), fresh: count('Fresh Wallets'), snipers: count('Sniper Wallets')};
  }
  function mintFromURL(value) {
    const m = String(value).match(/^https:\/\/gmgn\.ai\/sol\/token\/([^/?#]+)\/?(?:[?#].*)?$/);
    const id = m ? m[1].split('_').pop() : '';
    return MINT.test(id) ? id : null;
  }
  const gmgnURL = mint => { if (!MINT.test(mint)) throw Error('Invalid contract'); return 'https://gmgn.ai/sol/token/' + mint; };
  function selectPair(rows, mint, pinned) {
    const eligible = (Array.isArray(rows) ? rows : []).filter(p => p.chainId === 'solana' && p.baseToken?.address === mint && number(p.priceUsd) > 0);
    return eligible.find(p => p.pairAddress === pinned) || eligible.sort((a,b) => (number(b.liquidity?.usd) || 0) - (number(a.liquidity?.usd) || 0))[0] || null;
  }
  function normalize(p, at) {
    if (!p) return null;
    return {at, pair: p.pairAddress, dex: p.dexId, price: number(p.priceUsd),
      marketCap: number(p.marketCap), fdv: number(p.fdv), liquidity: number(p.liquidity?.usd),
      buys5m: number(p.txns?.m5?.buys), sells5m: number(p.txns?.m5?.sells),
      volume5m: number(p.volume?.m5), volume1h: number(p.volume?.h1),
      priceChange5m: number(p.priceChange?.m5), pairCreatedAt: number(p.pairCreatedAt),
      source: 'DEX Screener snapshot', sourceTime: null};
  }
  function assess(call, s, now, error) {
    const reasons = [], risks = [], missing = ['1m trade flow unavailable', 'Unique trading wallets unavailable'];
    if (call?.conflict) risks.push('Alert has conflicting migration/volume fields');
    if (call?.clusters?.length && Math.max(...call.clusters) >= 20) risks.push('Reported largest cluster ≥20% (review flag, not a proven cutoff)');
    if (call?.topHolder >= 5) risks.push('Reported top holder ≥5% (review flag)');
    if (call?.fresh != null && call.holders > 0) reasons.push(Math.round(call.fresh/call.holders*100) + '% fresh-wallet labels at call; categories can overlap');
    if (!call?.clusters?.length) missing.push('Call-time wallet clusters missing');
    if (!s || error || now - s.at > 30000 || s.at > now + 1000) {
      return {state:'UNKNOWN', side:'NO CURRENT SNAPSHOT', share:null, risks, missing,
        reasons:[error || (s ? 'Snapshot fetch is stale' : 'No indexed pool data yet'), ...reasons]};
    }
    const b=s.buys5m, sell=s.sells5m;
    const share = b != null && sell != null && b >= 0 && sell >= 0 && b+sell > 0 ? 100*b/(b+sell) : null;
    let side = share === null ? 'UNKNOWN' : share >= 60 ? 'BUY SIDE' : share <= 40 ? 'SELL SIDE' : 'MIXED';
    if (share != null) reasons.push(Math.round(share) + '% of 5m swap count is buys; not dollar flow or win probability');
    if (b != null && sell != null && b+sell < 20) risks.push('Fewer than 20 swaps in this window; weak sample');
    if (s.pairCreatedAt && now-s.pairCreatedAt < 300000) reasons.push('Pool younger than 5m: this window is partial');
    if (s.priceChange5m != null) reasons.push('5m price change ' + (s.priceChange5m>=0?'+':'') + s.priceChange5m.toFixed(1) + '%');
    if (call?.callMc > 0 && s.marketCap > 0) {
      const move = (s.marketCap/call.callMc-1)*100;
      reasons.push((move>=0?'+':'')+move.toFixed(1)+'% market-cap change since alert (provider definitions may differ)');
      if (move > 30) risks.push('More than 30% above call MC: review entry timing');
    }
    if (s.liquidity == null) missing.push('Indexed liquidity missing');
    else if (s.liquidity <= 0) risks.push('No positive indexed liquidity');
    reasons.push('Single indexed pool; upstream update delay is unknown');
    const state = risks.length ? 'CAUTION' : share === null ? 'UNKNOWN' : side === 'SELL SIDE' && s.priceChange5m < 0 ? 'FADE / REVIEW EXIT' : side === 'BUY SIDE' && s.priceChange5m > 0 ? 'WATCH BUY SETUP' : 'WAIT';
    return {state,side,share,reasons,risks,missing};
  }
  function initials(cost, proceeds, bag, feePct=0, fixed=0) {
    if (![cost,proceeds,bag,feePct,fixed].every(Number.isFinite) || cost<0 || proceeds<0 || bag<0 || feePct<0 || feePct>=100 || fixed<0) return {error:'Enter non-negative amounts in one currency; fee must be below 100%.'};
    const need=Math.max(0,cost-proceeds);
    if (!need) return {need:0,pct:0,covered:true,already:true};
    const netAll=bag*(1-feePct/100)-fixed;
    if (netAll < need) return {need,pct:100,covered:false,shortfall:need-Math.max(0,netAll)};
    return {need,pct:Math.min(100,100*(need+fixed)/(bag*(1-feePct/100))),covered:true};
  }
  function handoff(call, receipts, current, now, maxAge=30000) {
    if (!call || !MINT.test(call.mint) || !call.id || !Number.isFinite(call.messageAt)) return 'invalid';
    if (receipts[call.id]) return 'duplicate';
    if (call.messageAt > now+5000 || now-call.messageAt > maxAge || call.historical) return 'old';
    return current === call.mint ? 'already-open' : 'navigate';
  }
  return {MINT,number,money,parseAlert,mintFromURL,gmgnURL,selectPair,normalize,assess,initials,handoff};
})();
/* CORE END */

(function () {
  'use strict';
  if (window.top !== window.self) return;
  if (document.getElementById('vts-root')) return;
  if (document.getElementById('voltrak-ui')) {
    console.warn('[VolTrak Steroids] Old VolTrak script is still running. Disable v2 and reload before using v3.');
    GM_notification({title:'VolTrak: two versions enabled',text:'Disable the old VolTrak Call Alert script, then reload. Steroids has stopped.',timeout:15000});
    return;
  }
  const DISCORD=location.hostname==='discord.com', GMGN=location.hostname==='gmgn.ai';
  if (!DISCORD && !GMGN) return;
  const CHANNEL='1531866550968254514', PREFIX='vts3.', DOC=crypto.randomUUID();
  const get=(k,d)=>GM_getValue(PREFIX+k,d), set=(k,v)=>GM_setValue(PREFIX+k,v);
  const hasLocks=!!navigator.locks;
  const locked=(name,fn)=>hasLocks ? navigator.locks.request(PREFIX+name,fn) : Promise.resolve(null);
  const calls=()=>get('calls',[]), receiver=()=>get('receiver',null);
  const receiverAlive=r=>r && Date.now()-r.at<20000;
  let status='Starting', current=VTCore.mintFromURL(location.href), fetchError='', polling=false;
  let snapshot=null, lastMint=current, lastResponse=0;
  const root=document.createElement('section'); root.id='vts-root';
  root.innerHTML=`<style>
  #vts-root{position:fixed;right:16px;bottom:16px;width:350px;max-width:calc(100vw - 24px);z-index:2147483647;color:#e9eef6;font:12px/1.45 system-ui,sans-serif;box-shadow:0 8px 32px #0008;border:1px solid #3a4656;border-radius:14px;background:#111820}
  #vts-root *{box-sizing:border-box}#vts-root header{display:flex;align-items:center;gap:8px;padding:11px 13px;cursor:grab;border-bottom:1px solid #293444;font-weight:700}
  #vts-root .vts-body{padding:12px;max-height:70vh;overflow:auto}#vts-root h3{font-size:16px;margin:0 0 4px}#vts-root p{margin:6px 0}#vts-root .muted{color:#a7b4c4;font-size:11px}#vts-root .row{display:flex;justify-content:space-between;gap:8px;margin:5px 0}
  #vts-root button,#vts-root input,#vts-root select{font:inherit;border:1px solid #40516a;border-radius:6px;background:#1a2737;color:#edf3fc;padding:6px;max-width:100%}#vts-root button{cursor:pointer}#vts-root button:hover{background:#263b54}#vts-root input[type=checkbox]{width:auto}#vts-root input{width:100%}#vts-root .buttons{display:flex;gap:5px;flex-wrap:wrap;margin:8px 0}
  #vts-root .gauge{height:10px;position:relative;background:linear-gradient(90deg,#bf625f,#707d8f,#54ad91);border-radius:7px;margin:10px 0 4px}#vts-root .needle{height:18px;width:3px;background:white;position:absolute;top:-4px}#vts-root .warning{color:#f3c982}#vts-root ul{padding-left:16px;margin:8px 0}#vts-root details{border-top:1px solid #293444;margin-top:12px;padding-top:9px}#vts-root summary{cursor:pointer}#vts-root .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}#vts-root label{display:block;font-size:11px}#vts-root a{color:#8dc1ff}#vts-root .state{font-size:14px;font-weight:750;color:#e8d495}#vts-root code{word-break:break-all;font-size:10px}
  </style><header><span style="flex:1">VolTrak Steroids <small>3.0</small></span><button data-vts="collapse" title="Collapse">−</button></header><div class="vts-body">
  <div class="muted" data-vts="status"></div>
  <div data-vts="discord"><p>VolTrak calls → one GMGN receiver.</p><div data-vts="receiver"></div><p class="muted">Initial visible messages are saved for review. Only new, verified calls can move GMGN.</p></div>
  <div data-vts="gmgn"><div class="buttons"><button data-vts="claim">Use this GMGN tab</button><label><input data-vts="autoload" type="checkbox"> Load new calls</label></div>
  <h3 data-vts="token">Open a Solana token</h3><code data-vts="mint"></code><p class="muted" data-vts="feed"></p><div class="state" data-vts="state">UNKNOWN</div>
  <div class="gauge"><span class="needle" data-vts="needle" hidden></span></div><div class="row"><span>Sell side</span><b data-vts="share">—</b><span>Buy side</span></div>
  <p class="muted">Gauge = share of 5m swap COUNT. Experimental context, not a buy/sell order or a probability.</p>
  <div data-vts="metrics"></div><ul data-vts="reasons"></ul><ul class="warning" data-vts="risks"></ul><p class="muted" data-vts="missing"></p>
  <div class="buttons"><button data-vts="refresh">Refresh snapshot</button><button data-vts="copy">Copy CA</button></div>
  <details><summary>Recover initials</summary><p>GMGN already offers <b>Sell inits</b> in its Instant Trade tools. Use GMGN to review and submit the sale.</p><p class="muted">Optional calculator: enter all amounts in the same currency. Bag value should be your estimated gross executable sale value. Quotes and fees can change.</p>
  <div class="grid"><label>Total buy cost<input data-vts="cost" type="number" min="0" step="any"></label><label>Net proceeds received<input data-vts="proceeds" type="number" min="0" step="any" value="0"></label><label>Remaining bag value<input data-vts="bag" type="number" min="0" step="any"></label><label>Sale fee/slippage allowance %<input data-vts="fee" type="number" min="0" max="99" step="any" value="0"></label><label>Fixed sale cost<input data-vts="fixed" type="number" min="0" step="any" value="0"></label></div>
  <div class="buttons"><button data-vts="initials">Calculate only</button></div><p data-vts="initials-result"></p><p class="muted">No order is filled or submitted by this script. Alt+I opens this calculator.</p></details></div>
  <details><summary>Calls and recording</summary><select data-vts="call-list" style="width:100%"></select><div class="buttons"><button data-vts="open">Open selected on GMGN</button><button data-vts="export">Export observations</button></div><p class="muted">Records call-time context and fetched snapshots while the receiving GMGN tab is running. Rolling 5m snapshots cannot reconstruct 1m trades. Export regularly.</p><label>Paste a complete VolTrak alert or a contract<input data-vts="paste" placeholder="Contract or alert text"></label><button data-vts="import">Add for review</button></details>
  <details><summary>Data and controls</summary><p>Free DEX Screener snapshots: polls every 10s. Provider delay unknown. One indexed pool per token. No private keys or trading endpoints.</p><p>1m trade volume, unique wallets and market-wide graduation counts need a separate trade/migration feed. They are not inferred from these snapshots.</p><label><input type="checkbox" data-vts="sound"> Voice on Discord only</label><p class="muted">Alt+V hides/shows this panel. Drag the header. Disable the old VolTrak script before using this replacement.</p></details>
  </div>`;
  document.body.appendChild(root);
  const $=key=>root.querySelector('[data-vts="'+key+'"]');
  $('discord').hidden=!DISCORD; $('gmgn').hidden=!GMGN;
  $('autoload').checked=get('autoload',true); $('sound').checked=get('sound',true);
  $('autoload').onchange=()=>set('autoload',$('autoload').checked);
  $('sound').onchange=()=>set('sound',$('sound').checked);
  $('collapse').onclick=()=>{const b=root.querySelector('.vts-body');b.hidden=!b.hidden;$('collapse').textContent=b.hidden?'+':'−';};
  let drag=null;
  root.querySelector('header').onpointerdown=e=>{if(e.target.closest('button'))return;const b=root.getBoundingClientRect();drag={x:e.clientX-b.left,y:e.clientY-b.top};e.currentTarget.setPointerCapture(e.pointerId);};
  root.querySelector('header').onpointermove=e=>{if(!drag)return;root.style.left=Math.max(0,Math.min(innerWidth-root.offsetWidth,e.clientX-drag.x))+'px';root.style.top=Math.max(0,Math.min(innerHeight-root.offsetHeight,e.clientY-drag.y))+'px';root.style.right='auto';root.style.bottom='auto';};
  root.querySelector('header').onpointerup=()=>{drag=null;};
  document.addEventListener('keydown',e=>{if(!e.altKey||e.ctrlKey||e.metaKey)return;if(e.key.toLowerCase()==='v'){root.hidden=!root.hidden;e.preventDefault();}if(GMGN&&e.key.toLowerCase()==='i'){root.hidden=false;root.querySelector('.vts-body').hidden=false;$('initials').closest('details').open=true;e.preventDefault();}});
  function listText(el,rows){el.replaceChildren(...rows.map(t=>{const li=document.createElement('li');li.textContent=t;return li;}));}
  const fmt=n=>n==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:2,notation:'compact'}).format(n);
  const usd=n=>n==null?'—':'$'+fmt(n);
  const recentCall=m=>calls().filter(c=>c.mint===m).sort((a,b)=>b.messageAt-a.messageAt)[0]||null;
  let listSignature='';
  function render(){
    $('status').textContent=status+(hasLocks?'':' · Browser Web Locks unavailable: automatic relay disabled');
    const all=calls().slice().sort((a,b)=>b.messageAt-a.messageAt), signature=all.map(c=>c.id).join('|');
    if(signature!==listSignature){const v=$('call-list').value;$('call-list').replaceChildren(...all.slice(0,100).map(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name+' · '+new Date(c.messageAt).toLocaleTimeString()+(c.historical?' · history':'');return o;}));if(all.some(c=>c.id===v))$('call-list').value=v;listSignature=signature;}
    if(DISCORD){$('receiver').textContent=receiverAlive(receiver())?'GMGN receiver connected':'Open GMGN and choose “Use this GMGN tab”.';return;}
    const c=recentCall(current), a=VTCore.assess(c,snapshot,Date.now(),fetchError);
    $('token').textContent=c?.name|| (current?'Token context':'Open a Solana token');$('mint').textContent=current||'';
    $('feed').textContent=snapshot?'DEX snapshot fetched '+Math.max(0,Math.floor((Date.now()-snapshot.at)/1000))+'s ago · upstream delay unknown':'Waiting for an indexed DEX pool';
    $('state').textContent=a.state;$('share').textContent=a.share==null?'—':Math.round(a.share)+'% buys';$('needle').hidden=a.share==null;if(a.share!=null)$('needle').style.left=Math.max(0,Math.min(100,a.share))+'%';
    const rows=[['5m swap volume',usd(snapshot?.volume5m)],['1h swap volume',usd(snapshot?.volume1h)],['5m buys / sells',(snapshot?.buys5m??'—')+' / '+(snapshot?.sells5m??'—')],['Indexed pool liquidity',usd(snapshot?.liquidity)],['Market cap / call MC',usd(snapshot?.marketCap)+' / '+usd(c?.callMc)],['Pool',snapshot?(snapshot.dex||'DEX')+' · '+snapshot.pair?.slice(0,6):'—'],['Alert migration status',c?.migrated==null?'unknown':c.migrated?'Migrated (at call)':'Bonding curve (at call)'],['Largest reported cluster',c?.clusters?.length?Math.max(...c.clusters)+'%':'—']];
    $('metrics').replaceChildren(...rows.map(([k,v])=>{const d=document.createElement('div');d.className='row';const l=document.createElement('span'),r=document.createElement('b');l.textContent=k;r.textContent=v;d.append(l,r);return d;}));
    listText($('reasons'),a.reasons);listText($('risks'),a.risks);$('missing').textContent=a.missing.join(' · ');
  }
  async function addCall(call){
    return locked('call-write',()=>{const all=calls();if(all.some(c=>c.id===call.id))return false;set('calls',[call,...all].slice(0,500));return true;});
  }
  function announce(call){
    // Only Discord announces. No sound in GMGN and no repeated speech after navigation.
    if(!get('sound',true))return;
    try{const u=new SpeechSynthesisUtterance('VolTrak. '+call.name+'. Check Steroids.');u.rate=1.05;speechSynthesis.speak(u);}catch(_){}
  }
  function http(mints){return new Promise(resolve=>GM_xmlhttpRequest({method:'GET',url:'https://api.dexscreener.com/tokens/v1/solana/'+mints.join(','),timeout:10000,onload:r=>{if(r.status!==200)return resolve(null);try{const a=JSON.parse(r.responseText);resolve(Array.isArray(a)?a:null);}catch(_){resolve(null);}},onerror:()=>resolve(null),ontimeout:()=>resolve(null)}));}
  async function ownReceiver(force=false){
    return locked('receiver',()=>{const r=receiver();if(force||!receiverAlive(r)||r.id===DOC){set('receiver',{id:DOC,at:Date.now()});return true;}return false;});
  }
  let receiving=false;
  async function receiveLatest(){
    if(receiving||!get('autoload',true))return;
    receiving=true;
    try{await locked('handoff',()=>{
      if(receiver()?.id!==DOC)return;
      const call=get('latest',null), receipts=get('receipts',{});
      const action=VTCore.handoff(call,receipts,VTCore.mintFromURL(location.href),Date.now());
      if(action!=='navigate'&&action!=='already-open')return;
      // Durable receipt BEFORE navigation: startup replay cannot reload this call again.
      receipts[call.id]=Date.now();set('receipts',Object.fromEntries(Object.entries(receipts).sort((a,b)=>b[1]-a[1]).slice(0,1000)));
      status='Received '+call.name+' once';
      if(action==='navigate')location.assign(VTCore.gmgnURL(call.mint));
    });}finally{receiving=false;}
  }
  async function poll(force=false){
    if(!GMGN||polling||!current)return;
    if(!force&&Date.now()-lastResponse<10000)return;
    if(receiver()?.id!==DOC){status='Display only · another GMGN tab receives calls';render();return;}
    polling=true;
    try{
      const now=Date.now();const tracked=[...new Set([current,...calls().filter(c=>!c.historical&&now-c.receivedAt<90*60000).map(c=>c.mint)])].slice(0,20);
      const rows=await http(tracked);lastResponse=Date.now();
      if(rows===null){fetchError='DEX request failed; gauge withheld';status=fetchError;render();return;}
      fetchError='';
      for(const mint of tracked){
        const key='samples.'+mint, samples=get(key,[]), previous=samples[samples.length-1];
        const pair=VTCore.selectPair(rows,mint,previous?.pair), s=VTCore.normalize(pair,lastResponse);
        if(mint===current){snapshot=s;fetchError=s?'':'No indexed pool yet; this does not mean zero trading';}
        if(!s)continue;
        set(key,[...samples.filter(x=>lastResponse-x.at<2*3600000),s].slice(-720));
      }
      const keys=get('recordedMints',[]);const merged=[...new Set([...tracked,...keys])];set('recordedMints',merged.slice(0,100));
      // Bound browser storage by clearing only this version's oldest market observations.
      for(const mint of merged.slice(100))set('samples.'+mint,[]);
      status='Analysis only · snapshots every 10s · '+tracked.length+' token(s)';render();
    }finally{polling=false;}
  }
  $('claim').onclick=async()=>{await ownReceiver(true);status='This GMGN tab receives calls';render();await poll(true);};
  $('refresh').onclick=()=>poll(true);$('copy').onclick=()=>{if(current)GM_setClipboard(current,'text');};
  $('initials').onclick=()=>{
    const raw=['cost','proceeds','bag','fee','fixed'].map(k=>$(k).value.trim());
    if(raw.some(x=>x==='')){$('initials-result').textContent='Fill every amount first.';return;}
    const r=VTCore.initials(...raw.map(Number));
    $('initials-result').textContent=r.error|| (r.already?'Initial cost already recovered.':r.covered?'Estimated sale: '+r.pct.toFixed(2)+'% of remaining tokens to recover '+r.need.toFixed(6)+' before any unmodelled costs.':'Even 100% would not recover initials; estimated shortfall '+r.shortfall.toFixed(6)+'.');
  };
  $('open').onclick=()=>{const c=calls().find(c=>c.id===$('call-list').value);if(!c)return;if(GMGN){if(VTCore.mintFromURL(location.href)!==c.mint)location.assign(VTCore.gmgnURL(c.mint));}else GM_openInTab(VTCore.gmgnURL(c.mint),{active:true,insert:true});};
  $('import').onclick=async()=>{
    const input=$('paste').value.trim(), parsed=VTCore.parseAlert(input);
    const c=parsed||(VTCore.MINT.test(input)?{mint:input,name:input.slice(0,8),clusters:[]}:null);
    if(!c){status='Paste a contract or the complete alert text';render();return;}
    await addCall({...c,id:'manual-'+crypto.randomUUID(),messageAt:Date.now(),receivedAt:Date.now(),historical:true,manual:true});status='Added for review; paste time is not original alert time';$('paste').value='';render();
  };
  $('export').onclick=()=>{
    const all=calls(), mints=get('recordedMints',[]), payload={version:'3.0.0',exportedAt:new Date().toISOString(),calls:all,
      coverage:{feed:'DEX Screener rolling snapshots',tradeByTrade:false,upstreamTimestamps:false,marketWide:false,retention:'500 calls; 100 observed mints; at most 2h/720 observations per mint; only while receiver runs'},
      samples:Object.fromEntries(mints.map(m=>[m,get('samples.'+m,[])]))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='voltrak-steroids-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  GM_addValueChangeListener(PREFIX+'calls',()=>render());
  if(GMGN){
    GM_addValueChangeListener(PREFIX+'latest',()=>receiveLatest());
    async function tick(){
      const next=VTCore.mintFromURL(location.href);
      if(next!==lastMint){lastMint=next;current=next;snapshot=null;fetchError='';lastResponse=0;}
      const owner=await ownReceiver();if(owner){await receiveLatest();await poll();}else status='Display only · choose this tab to receive';render();
    }
    tick();setInterval(tick,3000);
  }
  if(DISCORD){
    let initial=true,lastChannel='',timer=null,scanning=false;
    const authorOf=li=>{for(let n=li,i=0;n&&i<500;n=n.previousElementSibling,i++){const u=n.querySelector?.('[id^="message-username-"]');if(u)return u.textContent.trim();}return '';};
    const originalTime=li=>{const t=li.querySelector('time[datetime]');if(t)return Date.parse(t.getAttribute('datetime'));const id=li.id.match(/-(\d+)$/)?.[1];try{return id?Number(BigInt(id)>>22n)+1420070400000:NaN;}catch(_){return NaN;}};
    const alertText=li=>{const title=li.querySelector('[class*="embedTitle"]')?.textContent?.trim();if(!title)return li.innerText||'';const labels=[...li.querySelectorAll('[class*="embedFieldName"]')];
      return title+'\n'+labels.map(e=>e.textContent+'\n'+(e.parentElement.querySelector('[class*="embedFieldValue"]')?.textContent||'')).join('\n');};
    async function scan(){
      if(scanning)return;scanning=true;
      try{
        const channel=location.pathname.split('/')[3];
        if(channel!==lastChannel){lastChannel=channel;initial=true;}
        if(channel!==CHANNEL){status='Waiting for the configured VolTrak channel';render();return;}
        const existing=new Set(calls().map(c=>c.id));
        const lis=[...document.querySelectorAll('li[id^="chat-messages-"]')];
        // Never arm from an empty/loading message list: first complete screen is history.
        if(!lis.length)return;
        let parsedCount=0;
        for(const li of lis){
          const id=li.id.match(/-(\d+)$/)?.[1];if(!id||existing.has(id))continue;
          if(authorOf(li).toLowerCase()!=='voltrak')continue;
          const parsed=VTCore.parseAlert(alertText(li));if(!parsed)continue;parsedCount++;
          const messageAt=originalTime(li), now=Date.now();if(!Number.isFinite(messageAt))continue;
          const historical=initial||now-messageAt>30000||messageAt>now+5000;
          const call={...parsed,id,messageAt,receivedAt:now,historical};
          if(!await addCall(call))continue;existing.add(id);
          if(!historical){
            await locked('publish',()=>{
              const last=get('mint-alert.'+call.mint,0);if(now-last<60000)return;
              set('mint-alert.'+call.mint,now);set('latest',call);
              GM_setClipboard(call.mint,'text');announce(call);
              GM_notification({title:'VolTrak · '+call.name,text:receiverAlive(receiver())?'Context sent to GMGN.':'No GMGN receiver. Open GMGN to review.',timeout:6000});
            });
          }
        }
        if(parsedCount||calls().some(c=>lis.some(li=>li.id.endsWith('-'+c.id))))initial=false;
        status='Watching VolTrak · '+calls().length+' calls saved';render();
      }finally{scanning=false;}
    }
    const mo=new MutationObserver(mutations=>{if(mutations.every(m=>root.contains(m.target)))return;clearTimeout(timer);timer=setTimeout(scan,120);});
    mo.observe(document.body,{childList:true,subtree:true});setTimeout(scan,2000);setInterval(scan,5000);
  }
  render();
})();
