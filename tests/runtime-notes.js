// Load only in an isolated profile's temporary addon, after app.start().
(async () => {
  const out = { version: '0.1.12', checks: [], errors: [], liveNotion: false };
  const check = (value, message) => { if (!value) throw Error(message); out.checks.push(message); };
  try {
    if (!['/tmp/z2n-notes-data','/private/tmp/z2n-notes-data'].includes(Zotero.DataDirectory.dir))
      throw Error('Isolated notes test profile required');
    const app = Zotero.Zotero2Notion, win = Zotero.getMainWindow();
    if (app.store.config.dataSourceID || await app.credentials.read()) throw Error('Test profile must have no Notion connection');
    app.timers.clearTimeout(app.activationTimer);
    const paper = new Zotero.Item('journalArticle');paper.setField('title','Synthetic notes verification');await paper.saveTx();
    const first = new Zotero.Item('note');first.parentID=paper.id;first.setNote('<h2>First note</h2><p><strong>Bold</strong> <span class="math">$\\alpha$</span></p>');await first.saveTx();
    const second = new Zotero.Item('note');second.parentID=paper.id;second.setNote('<p>Second note</p>');await second.saveTx();
    const empty = new Zotero.Item('note');empty.parentID=paper.id;empty.setNote('<p> </p>');await empty.saveTx();
    const standalone = new Zotero.Item('note');standalone.setNote('<p>Standalone stays out</p>');await standalone.saveTx();
    const bytes=Uint8Array.from(win.atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVs8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    const picture = new Zotero.Item('note');picture.parentID=paper.id;picture.setNote('<p>Image note</p>');await picture.saveTx();
    const image = await Zotero.Attachments.importEmbeddedImage({blob:new win.Blob([bytes],{type:'image/png'}),parentItemID:picture.id});
    picture.setNote(`<p><img data-attachment-key="${image.key}" alt="Synthetic image"></p>`);await picture.saveTx();
    const notes=await app.engine.notes.readNotes({id:paper.id});
    check(notes.length===3,'Extracts multiple child notes, including an image-only note; skips empty and standalone notes');
    const firstData=notes.find(n=>n.id===first.id), pictureData=notes.find(n=>n.id===picture.id);
    check(firstData?.title.includes('First note'),'Uses Zotero note titles');
    const converted=await app.engine.notes.renderNote(firstData);
    check(converted.markdown.includes('**Bold**')&&converted.markdown.includes('$`\\alpha`$'),'Real Zotero DOM parser preserves formatting and inline math');
    const uploads=[];
    app.api.token=async()=> 'synthetic-token';
    app.api.fetch=async(url,options)=>{
      if (url.endsWith('/send')) {
        const file=options.body.get('file');uploads.push({length:file.size,type:file.type});
        if(options.headers['Content-Type'])throw Error('Multipart boundary must be set by fetch');
        return new win.Response(JSON.stringify({status:'uploaded'}),{status:200});
      }
      return new win.Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}),{status:200});
    };
    const rendered=await app.engine.notes.renderNote(pictureData);
    check(uploads.length===1&&uploads[0].length===bytes.length&&uploads[0].type==='image/png','Creates native multipart upload with the embedded image bytes and MIME type');
    check(rendered.images.length===1&&rendered.markdown.includes('file-upload://'),'Produces an upload marker for a real embedded image');
    const queue=[];app.store.config.autoSync=true;app.enqueue=async ids=>queue.push(...ids);
    await app.notify('modify','item',[image.id]);
    check(queue.includes(paper.id),'Embedded image changes queue the parent paper');
    check(app.store.config.templates.length===2,'Fresh install contains exactly two templates');
    for(const template of app.store.config.templates)check((await app.store.readTemplate(template)).includes('[zotero_notes]'),template.name+' includes the notes placeholder');
  } catch(error) { out.errors.push(String(error)+'\n'+error.stack); }
  await IOUtils.writeUTF8('/tmp/z2n-012-runtime-result.json',JSON.stringify(out,null,2));
})();
