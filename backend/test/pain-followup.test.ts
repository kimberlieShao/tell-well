import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkins } from '../src/checkins.js';
import { demoExtractor } from '../src/extractor.js';
import { parsePainScore } from '../../frontend/pain-score.js';

test('spoken score survives subsequent pain answers, review, and save without a repeated score question', async()=>{
 const store=new Checkins(demoExtractor);
 let state=await store.analyze({transcript:'My arm hurts.',painScale:'1-10'});
 const answer=async(text:string)=>{state=await store.analyze({sessionId:state.sessionId,version:state.version,questionId:state.nextQuestion!.id,transcript:text});};
 assert.equal(state.nextQuestion!.field,'severity');
 await answer('My pain level is seven out of ten.');
 assert.equal(state.symptoms[0].severityScore,7);
 assert.equal(state.nextQuestion!.field,'functionalImpact');await answer('Not affecting activities');
 assert.equal(state.nextQuestion!.field,'firstOccurrence');await answer('No, I have had it before');
 assert.equal(state.symptoms[0].firstOccurrence,false);
 assert.equal(state.nextQuestion!.field,'trend');await answer("It's better");
 assert.equal(state.nextQuestion!.field,'duration');await answer('For three days');
 assert.equal(state.status,'review');assert.equal(state.symptoms[0].severityScore,7);
 const saved=store.save({sessionId:state.sessionId,version:state.version,confirmed:true});
 assert.equal(saved.symptoms[0].severityScore,7);assert.equal(saved.symptoms[0].duration,'For three days');
});
test('new pain asks location and duration, skips comparison, and accepts spoken numbers conservatively',async()=>{
 const store=new Checkins(demoExtractor);let state=await store.analyze({transcript:'I have pain.',painScale:'1-10'});
 const answer=async(text:string)=>{state=await store.analyze({sessionId:state.sessionId,version:state.version,questionId:state.nextQuestion!.id,transcript:text});};
 assert.equal(state.nextQuestion!.field,'location');await answer('My left shoulder');
 await answer('six');await answer('Making activities harder');await answer('Yes, first time');
 assert.equal(state.nextQuestion!.field,'duration');await answer('Since yesterday');
 assert.equal(state.status,'review');assert.equal(state.symptoms[0].trend,null);
 for(const text of ['four or five','not seven','eleven','severe'])assert.equal(parsePainScore(text),null);
});


test('saved medication names resolve without relying on the demo name whitelist',async()=>{
 const {createCheckinClient}=await import(new URL('../../frontend/checkin-api.js',import.meta.url).href);
 let body:any;let version=0;
 const client=createCheckinClient({getMedications:()=>[{name:'Metformin',dose:'500 mg'}],fetchImpl:async(_url:any,options:any)=>{
 body=JSON.parse(options.body);
 return {ok:true,json:async()=>({schemaVersion:'1.0',sessionId:'test',version:++version,status:'collecting',symptoms:[],medications:[],diet:[],vitals:[],nextQuestion:{id:'med:name',category:'medications',field:'name',text:'Which medication?',options:[]}})};
 }});
 await client.start('I took medicine.');await client.answer('I took Metformin 500 mg.',{spoken:true});
 assert.deepEqual(body.answer,{questionId:'med:name',value:'Metformin'});
 await client.answer('Maybe Metformin',{spoken:true});assert.equal(body.transcript,'Maybe Metformin');
 await client.answer('A white pill',{spoken:true});assert.equal(body.transcript,'A white pill');
});
