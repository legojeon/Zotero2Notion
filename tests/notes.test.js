import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { NotesSync, notesPlacement, findNoteToggle, canonicalNote, noteLink, groupLink, wrapNote, wrapNotes } from '../src/notes.js';
import { noteHTMLToMarkdown } from '../src/note-html.js';
import { NotionClient } from '../src/notion.js';
const item = {id:1, values:{'Zotero URI':'https://www.zotero.org/users/1/items/PAPER'}};
const note = (key='A',html='<p>First note</p>') => ({key, html, title:'Note '+key, uri:'https://www.zotero.org/users/1/items/'+key});
const convert = (html, image = async () => '![image](https://example.org/image.png)') => noteHTMLToMarkdown(html,{parse:html=>parseHTML('<html><body>'+html+'</body></html>').document,image});
function fixture(body='# Before\n[zotero_notes]\n# After', notes=[note()]) {
 const calls=[];let reads=0;
 const record={pageID:'page'};
 const api={
  markdown:async()=>({markdown:body}),
  async editMarkdown(id,oldText,newText){calls.push(['edit',oldText,newText]);assert.equal(body.split(oldText).length-1,1,'replacement must be unique');body=body.replace(oldText,()=>newText);return {markdown:body};},
  async appendMarkdown(id,text){calls.push(['append']);body+='\n'+text;return {markdown:body};},
  async insertMarkdown(id,text){calls.push(['insert']);body=text+'\n'+body;return {markdown:body};},
 };
 const store={saveState:async()=>{}};
 const engine=new NotesSync({api,store,readNotes:async()=>{reads++;return notes;},renderNote:async n=>({markdown:await convert(n.html)})});
 return {engine,api,record,store,calls,get body(){return body},set body(x){body=x},get notes(){return notes},set notes(x){notes=x},get reads(){return reads},run:p=>engine.sync(item,record,p===undefined?notesPlacement('# Before\n[zotero_notes]\n# After'):p)};
}
test('notes token is opt-in, standalone, unique, and ignores fenced examples',()=>{
 assert.equal(notesPlacement('No token'),undefined);
 assert.equal(notesPlacement('```md\n[zotero_notes]\n```'),undefined);
 assert.deepEqual(notesPlacement('Before\n[zotero_notes]\nAfter'),{before:'Before\n',after:'After'});
 assert.throws(()=>notesPlacement('inline [zotero_notes]'),/own line/);
 assert.throws(()=>notesPlacement('[zotero_notes]\n[zotero_notes]'),/once/);
});
test('absent token does not read notes or modify any existing content',async()=>{const f=fixture();await f.run(null);assert.equal(f.reads,0);assert.equal(f.calls.length,0)});
test('multiple child notes appear exactly at the marker and retry creates no duplicates',async()=>{
 const f=fixture(undefined,[note('A'),note('B','<h2>Other</h2>')]);await f.run();
 assert(f.body.indexOf('# Before')<f.body.indexOf('Zotero Notes'));assert(f.body.indexOf('Zotero Notes')<f.body.indexOf('# After'));
 assert(findNoteToggle(f.body,noteLink(note('A'))));assert(findNoteToggle(f.body,noteLink(note('B'))));assert(!f.body.includes('[zotero_notes]'));
 const n=f.calls.length;await f.run();assert.equal(f.calls.length,n);
});
test('no notes removes the marker; a later note uses the retained middle placement',async()=>{
 const f=fixture(undefined,[]);await f.run();assert(!f.body.includes('zotero_notes'));assert(!f.body.includes('Zotero Notes'));
 f.notes=[note()];await f.run();assert(f.body.indexOf('Zotero Notes')<f.body.indexOf('# After'));
});
test('changed note is replaced alone; personal sections and other notes survive',async()=>{
 const f=fixture(undefined,[note('A'),note('B')]);await f.run();
 const other=findNoteToggle(f.body,noteLink(note('B'))).text;
 f.body+='\nPersonal edits stay here';f.notes[0].html='<p>Updated $ text</p>';
 await f.run();assert(f.body.includes('Updated \\$ text'));assert(f.body.includes(other));assert(f.body.endsWith('Personal edits stay here'));
 assert(!f.calls.at(-1)[1].includes('Zotero Notes'));
});
test('new note is added within the existing group without replacing older notes',async()=>{
 const f=fixture();await f.run();const old=findNoteToggle(f.body,noteLink(note())).text;
 f.notes.push(note('B'));await f.run();assert(f.body.includes(old));assert(findNoteToggle(findNoteToggle(f.body,groupLink(item)).text,noteLink(note('B'))));
});
test('Notion edits block a conflicting source change and explicit review retains them',async()=>{
 const f=fixture();await f.run();f.body=f.body.replace('First note','Personal Notion edit');f.notes[0].html='<p>Zotero update</p>';
 const before=f.body;await assert.rejects(f.run(),/edited in Notion/);assert.equal(f.body,before);assert(f.record.notes.conflict);
 await f.engine.acceptCurrent(item,f.record);await f.run();assert.equal(f.body,before);
 f.notes[0].html='<p>Next intentional source update</p>';await f.run();assert(f.body.includes('Next intentional source update'));
});
test('source deletion and removing the template token preserve imported notes',async()=>{
 const f=fixture();await f.run();const before=f.body;f.notes=[];await f.run();assert.equal(f.body,before);await f.run(null);assert.equal(f.body,before);
});
test('a removed managed group is not silently recreated',async()=>{
 const f=fixture();await f.run();f.body='# Personal text';await assert.rejects(f.run(),/removed or renamed/);assert.equal(f.body,'# Personal text');
});
test('existing pages use an end marker safely, while ambiguous middle placement requires a marker',async()=>{
 const f=fixture('# Existing review');await assert.rejects(f.run(),/existing page/);assert.equal(f.body,'# Existing review');
 await f.run(notesPlacement('Some template\n[zotero_notes]'));assert(f.body.startsWith('# Existing review'));
});
test('uncertain applied writes are not repeated; review binds the already-created notes',async()=>{
 const f=fixture();const original=f.api.editMarkdown;f.api.editMarkdown=async(...a)=>{await original(...a);throw Error('response lost')};
 await assert.rejects(f.run(),/response lost/);assert(f.record.notes.pending);const before=f.body;
 await assert.rejects(f.run(),/unconfirmed/);assert.equal(f.body,before);
 await f.engine.acceptCurrent(item,f.record);await f.run();assert.equal(f.body,before);assert.equal(f.calls.length,1);
});
test('rejected writes can be retried and truncated pages remain untouched',async()=>{
 const f=fixture();f.api.editMarkdown=async()=>{throw Object.assign(Error('rate limited'),{status:429})};await assert.rejects(f.run());assert(!f.record.notes.pending);
 f.api.markdown=async()=>({markdown:f.body,truncated:true});await assert.rejects(f.run(),/complete page/);assert.equal(f.calls.length,0);
});
test('duplicate note toggles and fake toggle tags inside code are handled safely',()=>{
 const block=wrapNote(note(),'```html\n</details>\n```');const group=wrapNotes(item,[block]);assert(findNoteToggle(group,noteLink(note())).text.includes('</details>\n'));
 assert.throws(()=>findNoteToggle(group+'\n'+group,noteLink(note())),/Duplicate/);
});
test('signed image URL refreshes do not look like user edits',()=>{
 assert.equal(canonicalNote('https://s3.us-west-2.amazonaws.com/secure.notion-static.com/id/img.png?signature=1'),canonicalNote('https://s3.us-west-2.amazonaws.com/secure.notion-static.com/id/img.png?signature=2'));
 assert.notEqual(canonicalNote('https://example.org/?a=1'),canonicalNote('https://example.org/?a=2'));
});
test('HTML converts rich formatting, nested lists, tables and literal code',async()=>{
 const md=await convert('<h2>Title</h2><p><strong>bold</strong> <em>italic</em> <u>underline</u> <a href="https://example.org">link</a></p><ul><li>First<ul><li>Nested</li></ul></li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre>const x = "[authors]";\n\\alpha</pre>');
 for(const text of ['## Title','**bold**','*italic*','underline="true"','[link](https://example.org)','- First','\t- Nested','<table header-row="true">','const x = "[authors]";','\\alpha'])assert(md.includes(text),text);
});
test('LaTeX survives with single backslashes and is never substituted as metadata',async()=>{
 const md=await convert('<p>Inline <span class="math">$\\alpha + x_1$</span></p><pre class="math">$$\\frac{a}{b}$$</pre>');
 assert(md.includes('$`\\alpha + x_1`$'));assert(md.includes('$$\n\\frac{a}{b}\n$$'));assert(!md.includes('\\\\alpha'));
});
test('images-only notes call the image adapter; executable markup cannot escape into Notion',async()=>{
 let calls=0;assert((await convert('<p><img data-attachment-key="IMAGE"></p>',async n=>{calls++;assert.equal(n.getAttribute('data-attachment-key'),'IMAGE');return '![uploaded](https://example.org/image.png)'})).includes('uploaded'));assert.equal(calls,1);
 const md=await convert('<script>danger</script><a href="javascript:danger()">safe text</a><p>&lt;details&gt; [zotero_notes]</p>');assert(!md.includes('danger'));assert(md.includes('safe text'));assert(md.includes('\\<details\\>'));assert(md.includes('\\[zotero\\_notes\\]'));
});
test('unsupported merged tables fail explicitly before they can lose cell content',async()=>{await assert.rejects(convert('<table><tr><td colspan="2">Text</td></tr></table>'),/merged/)});
test('PDF annotations and citations retain source links',async()=>{
 const annotation=encodeURIComponent(JSON.stringify({attachmentURI:'http://zotero.org/users/1/items/ABCD1234',position:{pageIndex:3},annotationKey:'NOTE1234'}));
 const citation=encodeURIComponent(JSON.stringify({citationItems:[{uris:['https://zotero.org/users/1/items/PAPER']}]}));
 const md=await convert(`<p><span data-annotation="${annotation}">quoted</span><span class="citation" data-citation="${citation}">(Author, 2026)</span></p>`);
 assert(md.includes('zotero://open-pdf/library/items/ABCD1234?page=4&annotation=NOTE1234'));assert(md.includes('https://zotero.org/users/1/items/PAPER'));
});
test('image upload uses multipart and attaches only matching generated images',async()=>{
 const requests=[];const api=new NotionClient({token:async()=>'test',fetch:async(url,options)=>{
 requests.push({url,...options});let data;
 if(url.endsWith('/file_uploads'))data={id:'upload'};
 else if(url.endsWith('/send')){assert(options.body instanceof FormData);assert(!options.headers['Content-Type']);data={status:'uploaded'}}
 else if(url.includes('/blocks/page/children'))data={results:[{id:'note-block',type:'toggle',has_children:true,toggle:{rich_text:[{text:{link:{url:'source-note'}}}]}}],has_more:false};
 else if(url.includes('/children'))data={results:[{id:'image-block',type:'image',image:{caption:[{plain_text:'z2n-image-upload'}]}}],has_more:false};
 else data={id:'image-block'};
 return {ok:true,json:async()=>data};
 }});
 assert.equal(await api.uploadNoteImage(new Uint8Array([1]),'image/png'),'upload');await api.finishNoteImages('page',[{id:'upload',marker:'z2n-image-upload',caption:'Figure',noteLink:'source-note'}]);
 const patch=JSON.parse(requests.at(-1).body);assert.equal(patch.image.file_upload.id,'upload');assert.equal(patch.image.caption[0].text.content,'Figure');
});

test('Notion-escaped block marker is recognized and code examples stay literal', async()=>{
 const f=fixture('# Before\n\\[zotero_notes\\]\n# After');await f.run();assert(f.body.includes('Zotero Notes'));assert(!f.body.includes('zotero_notes'));
 assert.deepEqual(notesPlacement('```md\n[zotero_notes]\n```\n[zotero_notes]'),{before:'```md\n[zotero_notes]\n```\n',after:''});
});
test('edits arriving during image upload stop the write without changing Notion',async()=>{
 const f=fixture();await f.run();f.notes[0].html='<p>Source changed</p>';
 f.engine.renderNote=async()=>{f.body=f.body.replace('First note','Edited during upload');return {markdown:'Source changed'}};
 await assert.rejects(f.run(),/during sync/);assert(f.body.includes('Edited during upload'));assert(!f.record.notes.pending);assert(f.record.notes.conflict);
});
test('signed-image replacement is bounded by one note and keeps adjacent content',async()=>{
 const f=fixture(undefined,[note('A','<img>'),note('B')]);
 f.engine.renderNote=async n=>({markdown:n.key==='A'?'![Image](https://files.s3.amazonaws.com/img.png?sig=old)':await convert(n.html)});
 await f.run();const other=findNoteToggle(f.body,noteLink(note('B'))).text;
 f.api.replaceNoteRange=async(id,range,text)=>{const [start,end]=range.split('...');const begin=f.body.indexOf(start);const finish=f.body.indexOf(end,begin)+end.length;assert(begin>=0);assert.equal(f.body.slice(begin,finish),findNoteToggle(f.body,noteLink(note('A'))).text);f.body=f.body.slice(0,begin)+text+f.body.slice(finish);return {markdown:f.body}};
 f.notes[0].html='<img><p>New</p>';await f.run();assert(f.body.includes(other));assert(!f.record.notes.pending);
});
test('recovery does not falsely clear a conflict for a deleted imported note',async()=>{
 const f=fixture();await f.run();const block=findNoteToggle(f.body,noteLink(note()));f.body=f.body.replace(block.text,'');f.notes[0].html='<p>Changed</p>';
 await assert.rejects(f.run(),/edited in Notion/);await assert.rejects(f.engine.acceptCurrent(item,f.record),/Restore/);assert(f.record.notes.conflict);
});
