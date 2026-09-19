import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/app.js';
import { demoExtractor } from '../src/extractor.js';
const read=(path:string)=>readFile(new URL('../../'+path,import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('auth and onboarding routes serve only their public assets',async()=>{
 const server=createApp(demoExtractor).listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
 const root=await fetch(base,{redirect:'manual'});assert.equal(root.headers.get('location'),'/auth/');
 for(const path of ['/auth/','/auth/app.js','/auth/styles.css','/onboarding/','/onboarding/app.js','/onboarding/style.css','/frontend/profile-store.js','/app'])assert.equal((await fetch(base+path)).status,200,path);
 for(const path of ['/auth/test/forms.cjs','/onboarding/README.md','/backend/.env'])assert.equal((await fetch(base+path)).status,404,path);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('setup saves across page loads, binds Home/More, and isolates profile facts from check-in',async()=>{
 const dom=new JSDOM(await read('onboarding/index.html'),{url:'https://example.test/onboarding/',runScripts:'outside-only'});
 const w=dom.window as any;w.structuredClone=structuredClone;
 w.eval(await read('frontend/profile-store.js'));w.eval(await read('onboarding/app.js'));await tick();
 const click=async(s:string)=>{const b=w.document.querySelector(s);assert.ok(b,s);b.click();await tick();};
 w.document.getElementById('displayName').value='Kimberly';
 await click('[type=submit]');await click('[value="POTS"]');await click('[type=submit]');await click('#addMedication');
 w.document.getElementById('medName').value='Example medication';w.document.getElementById('medDose').value='5 mg';await click('#saveMed');
 await click('[type=submit]');await click('#skip');await click('[value="Symptoms"]');await click('[type=submit]');await click('[value="WHOOP"]');await click('[type=submit]');await click('[type=submit]');await click('[type=submit]');
 const profile=w.PulsewiseProfile.read();assert.equal(profile.onboardingCompleted,true);assert.equal(profile.displayName,'Kimberly');assert.deepEqual(Array.from(profile.conditions),['POTS']);assert.equal(w.document.querySelector('#actions a').getAttribute('href'),'/app');
 const home=new JSDOM(await read('index.html'),{url:'https://example.test/app',runScripts:'outside-only'});const hw=home.window as any;hw.structuredClone=structuredClone;hw.scrollTo=()=>{};
 hw.sessionStorage.setItem('pulsewise.demo-profile.v1',w.sessionStorage.getItem('pulsewise.demo-profile.v1'));hw.eval(await read('frontend/profile-store.js'));
 const {mountVersionB}=await import(new URL('../../frontend/new-ui.js',import.meta.url).href);
 const app=mountVersionB(hw.document,{initialProfile:hw.PulsewiseProfile.read(),profileStore:hw.PulsewiseProfile,conversationEnabled:false,speechFactory:()=>({available:false,cancel(){},destroy(){}}),speakerFactory:()=>({stop(){},destroy(){}})});
 try{
 assert.match(hw.document.querySelector('.patient-greeting h1').textContent,/Kimberly/);
 hw.document.querySelector('#desktopMoreNav').click();hw.document.querySelector('[data-more="profile"]').click();
 const text=hw.document.getElementById('moreDetailBody').textContent;assert.match(text,/POTS/);assert.doesNotMatch(text,/1958|Daniel/);assert.match(text,/WHOOP/);
 assert.equal(app.state.symptoms.length,0);assert.equal(app.state.medications.length,0);
 hw.PulsewiseProfile.patch({medications:[{id:'second',name:'Changed list',dose:'',schedule:''}]});
 hw.document.querySelector('#moreDetailBack').click();hw.document.querySelector('[data-more="medications"]').click();assert.match(hw.document.getElementById('moreDetailBody').textContent,/Changed list/);
 }finally{app.destroy();home.window.close();dom.window.close();}
});

test('corrupt demo data fails visibly rather than overwriting it',async()=>{
 const dom=new JSDOM(await read('onboarding/index.html'),{url:'https://example.test/onboarding/',runScripts:'outside-only'});const w=dom.window as any;w.structuredClone=structuredClone;
 w.sessionStorage.setItem('pulsewise.demo-profile.v1','broken');w.eval(await read('frontend/profile-store.js'));w.eval(await read('onboarding/app.js'));await tick();
 assert.match(w.document.getElementById('message').textContent,/could not be loaded/);assert.equal(w.sessionStorage.getItem('pulsewise.demo-profile.v1'),'broken');dom.window.close();
});
