import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const uiUrl = new URL('../../frontend/new-ui.js', import.meta.url).href;
const clientUrl = new URL('../../frontend/checkin-api.js', import.meta.url).href;
const symptom = (id: string, name: string) => ({ id, name, location: null, severity: null, severityScore: null, functionalImpact: null, duration: null, trend: null, firstOccurrence: null });
const diet = (id: string, description: string, time: string | null = null, waterGlasses: number | null = null, waterMode: string | null = null) => ({ id, description, time, waterGlasses, waterMode });
const base = (extra: any = {}) => ({schemaVersion:'1.0',sessionId:'session',version:1,status:'review',extractionMode:'gemini',symptoms:[],medications:[],diet:[],vitals:[],wellness:null,reportedAnswers:[],nextQuestion:null,missingFields:[],skippedFields:[],notices:[],...extra});
const until = async (check: () => unknown) => { const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('UI did not settle');await new Promise(resolve=>setTimeout(resolve,2));} };

async function withPage(starts: any[], run: (page: any) => Promise<void>, answer?: (state: any, body: any) => any) {
  const dom=new JSDOM(await readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://example.test/app',runScripts:'outside-only'});
  dom.window.scrollTo=()=>{};
  const [{mountVersionB},{createCheckinClient}]=await Promise.all([import(uiUrl),import(clientUrl)]);
  const page:any={dom,document:dom.window.document,requests:[],spoken:[],captures:[],saveGate:null};
  let state:any;
  const client=createCheckinClient({flow:'brief',painScale:'1-10',fetchImpl:async(path:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));page.requests.push({path,body});
    if(path.endsWith('/save')) {
      if(page.failSaveOnce){page.failSaveOnce=false;return Response.json({error:{code:'SAVE_FAILED',message:'Please retry saving.'}},{status:502});}
      if(page.saveGate)await page.saveGate;
      state={...state,...(body.record||{}),status:'saved',version:state.version+1,nextQuestion:null,savedAt:new Date().toISOString()};
    } else if(!body.sessionId) state=structuredClone(starts.shift());
    else state={...state,...(answer?answer(structuredClone(state),body):{}),status:'review',nextQuestion:null,version:state.version+1};
    return Response.json(state);
  }});
  const speechFactory=({textarea,onTurn}:any)=>{
    let active=false;
    const capture={available:true,mode:'form',get isActive(){return active;},async start(){active=true;},async finish(){active=false;return textarea.value;},cancel(){active=false;},destroy(){active=false;},async turn(text:string){textarea.value=text;active=false;await onTurn?.(text);},onTurn};
    page.captures.push(capture);return capture;
  };
  page.client=client;
  page.app=mountVersionB(page.document,{client,mealClient:client,conversationEnabled:false,speechFactory,speakerFactory:()=>({async prime(){},async speak(text:string){page.spoken.push(text);},stop(){},destroy(){}})});
  page.click=(selector:string)=>{const node=page.document.querySelector(selector);assert.ok(node,selector);node.click();};
  page.fill=(selector:string,value:string)=>{const node=page.document.querySelector(selector);assert.ok(node,selector);node.value=value;node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  page.ready=()=>page.document.getElementById('checkinFlow').getAttribute('aria-busy')!=='true';
  page.start=async()=>{page.app.open();page.click('#flowType');page.fill('#flowTranscript','Reported details');page.click('.flow-done');await until(()=>page.ready());};
  try{await run(page);}finally{page.app.destroy();dom.window.close();}
}

test('brief food and water log once, group unknown meals as snacks, and preserve exact add/total counts',async()=>{
  const food=base({sessionId:'food-1',diet:[diet('breakfast','eggs','breakfast'),diet('snack','apple'),diet('water','two glasses of water',null,2,'add')]});
  const total=base({sessionId:'water-2',diet:[diet('total','13.5 glasses today',null,13.5,'total')]});
  const zero=base({sessionId:'water-3',diet:[diet('zero','zero glasses today',null,0,'total')]});
  await withPage([food,total,zero],async page=>{
    await page.start();
    assert.equal(page.requests[0].body.flow,'brief');
    assert.equal(page.client.state.status,'saved');assert.equal(page.app.getCurrentScreen(),'trends');
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/save')).length,1);
    assert.deepEqual(page.app.mealState.meals.breakfast.map((x:any)=>x.name),['eggs']);
    assert.deepEqual(page.app.mealState.meals.snacks.map((x:any)=>x.name),['apple']);
    assert.equal(page.app.mealState.waterGlasses,2);
    page.click('#desktopMealsNav');page.click('#desktopHomeNav');page.click('#desktopMealsNav');
    assert.equal(page.app.mealState.waterGlasses,2);assert.equal(page.app.mealState.meals.snacks.length,1);
    page.click('#flowClose');await page.start();
    assert.equal(page.app.mealState.waterGlasses,13.5);
    assert.equal(page.document.getElementById('waterSlider').value,'13.5');
    assert.equal(page.document.getElementById('waterSlider').max,'13.5');
    assert.equal(page.app.mealState.meals.snacks.length,1);
    page.click('#flowClose');await page.start();assert.equal(page.app.mealState.waterGlasses,0);
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/save')).length,3);
  });
});

test('brief mixed check-in asks once, shows a compact symptom table, and waits for explicit save',async()=>{
  const details={id:'knee:details',category:'symptoms',entityId:'knee',field:'details',text:'What else would you like to add?',type:'text',options:[]};
  const first=base({status:'collecting',nextQuestion:details,symptoms:[symptom('knee','knee pain'),symptom('nausea','nausea')],diet:[diet('snack','apple')]});
  await withPage([first],async page=>{
    await page.start();assert.equal(page.app.getCurrentScreen(),'guided');
    const guided=page.document.querySelector('[data-screen="guided"]');
    assert.match(guided.querySelector('.guided-context').textContent,/Knee pain.*Nausea/);
    assert.deepEqual([...guided.querySelectorAll('.brief-details-note > li')].map(item=>item.textContent),['Symptom?','Location?','Pain score (1–10)?','Activities?','Since when?']);
    page.fill('#followupAnswer','It began yesterday.');page.click('#followupContinue');await until(()=>page.ready());
    assert.equal(page.app.getCurrentScreen(),'review');assert.equal(page.client.state.nextQuestion,null);
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/save')).length,0);
    const tables=[...page.document.querySelectorAll('.brief-symptom-table')];assert.equal(tables.length,2);
    for(const table of tables){
      assert.doesNotMatch(table.textContent,/Not Provided/);
      const empty=table.querySelector('.review-empty');
      assert.equal(empty.textContent,'—');assert.equal(empty.getAttribute('role'),'img');assert.equal(empty.getAttribute('aria-label'),'Not provided');
    }
    assert.equal(page.document.getElementById('reviewHint').hidden,false);
    assert.equal(page.document.querySelector('[data-record-id="knee"][data-record-field="location"]').value,'');
    page.click('#reviewConfirmSave');await until(()=>page.ready());
    const saved=page.requests.find((r:any)=>r.path.endsWith('/save')).body.record;
    assert.equal(saved.symptoms[0].location,null);assert.equal(saved.symptoms[0].severityScore,null);
    assert.deepEqual(page.app.mealState.meals.snacks.map((x:any)=>x.name),['apple']);
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/api/analyze')).length,2);
  },state=>({symptoms:state.symptoms.map((item:any)=>item.id==='knee'?{...item,duration:'yesterday'}:item)}));
});

test('a food-log save failure keeps a reviewable record and retries without double-counting water',async()=>{
  await withPage([base({diet:[diet('water','two glasses',null,2,'add')]})],async page=>{
    page.failSaveOnce=true;await page.start();
    assert.equal(page.app.getCurrentScreen(),'review');assert.equal(page.app.mealState.waterGlasses,0);
    assert.equal(page.client.state.status,'review');
    page.click('#reviewConfirmSave');await until(()=>page.ready());
    assert.equal(page.client.state.status,'saved');assert.equal(page.app.mealState.waterGlasses,2);
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/api/analyze')).length,1);
  });
});

test('voice food logging ends with a short confirmation and closing a pending save does not restart audio',async()=>{
  for(const closeDuringSave of [false,true])await withPage([base({sessionId:'voice-food',diet:[diet('water','two glasses',null,2,'add')]})],async page=>{
    page.app.open();await page.app.conversation.start();
    const openingCount=page.spoken.length;
    let release:()=>void=()=>{};
    if(closeDuringSave)page.saveGate=new Promise<void>(resolve=>{release=resolve;});
    const capture=page.captures.findLast((entry:any)=>entry.onTurn);
    const turn=capture.turn('I drank two glasses of water.');
    if(closeDuringSave){await until(()=>page.requests.some((r:any)=>r.path.endsWith('/save')));page.click('#flowClose');release();}
    await turn;
    assert.equal(page.client.state.status,'saved');assert.equal(page.app.mealState.waterGlasses,2);
    assert.equal(page.requests.filter((r:any)=>r.path.endsWith('/save')).length,1);
    assert.equal(page.app.conversation.active,false);
    if(closeDuringSave){assert.equal(page.spoken.length,openingCount);assert.equal(page.document.getElementById('checkinFlow').classList.contains('open'),false);}
    else{assert.equal(page.spoken.at(-1),'Water recorded.');assert.equal(page.app.getCurrentScreen(),'trends');assert.equal(page.app.conversation.state.phase,'saved');}
  });
});
