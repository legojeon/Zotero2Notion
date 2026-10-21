(async () => {
 const out={version:'0.1.4',checks:[],errors:[]};
 try {
  if(!['/tmp/z2n-test-data','/private/tmp/z2n-test-data'].includes(Zotero.DataDirectory.dir))throw Error('Isolated profile required');
  const app=Zotero.Zotero2Notion,w=Zotero.getMainWindow();
  const sleep=ms=>new Promise(r=>w.setTimeout(r,ms));
  if(app.store.config.dataSourceID)throw Error('Test profile must have no destination database');
  app.timers.clearTimeout(app.activationTimer);
  for(const p of Services.wm.getEnumerator(null)) if(p.location?.href?.includes('/preferences/preferences.xhtml')) p.close();
  await sleep(650); app.openSettings();
  let pref;
  for(let i=0;i<100;i++){await sleep(100);pref=[...Services.wm.getEnumerator(null)].find(p=>p.document.getElementById('z2n-root'));if(pref?.document.getElementById('z2n-markdown')?.value)break;}
  if(!pref)throw Error('Preferences did not open');
  const select=pref.document.getElementById('z2n-template');
  for(const id of ['section-summary-en','paper-review-en']) {
    if(![...select.options].some(o=>o.value===id))throw Error('Missing template option '+id);
    select.value=id;select.dispatchEvent(new pref.Event('change',{bubbles:true}));
    const expected=id==='section-summary-en'?'## Abstract':'## Problem';
    let text='';
    for(let i=0;i<50;i++){await sleep(100);text=pref.document.getElementById('z2n-markdown').value;if(text.includes(expected))break;}
    if(!text.includes(expected)||/[가-힣]/.test(text))throw Error('Incorrect English editor '+id);
    out.checks.push(id+' appears in preferences and loads English Markdown');
  }
  out.templates=app.store.config.templates.map(t=>({id:t.id,name:t.name}));
  const root=pref.document.getElementById('z2n-root');
  pref.document.getElementById('z2n-template-heading').scrollIntoView({block:'start',behavior:'instant'});await sleep(150);
  const canvas=pref.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=pref.innerWidth;canvas.height=pref.innerHeight;
  const bitmap=await pref.browsingContext.currentWindowGlobal.drawSnapshot(new pref.DOMRect(0,0,pref.innerWidth,pref.innerHeight),1,'rgb(255,255,255)');canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
  await IOUtils.write('/tmp/z2n-014-templates.png',Uint8Array.from(pref.atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0)));
 } catch(e){out.errors.push(String(e)+'\n'+e.stack);}
 await IOUtils.writeUTF8('/tmp/z2n-014-runtime-result.json',JSON.stringify(out,null,2));
})();
