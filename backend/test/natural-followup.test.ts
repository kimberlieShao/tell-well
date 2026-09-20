import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Checkins} from '../src/checkins.js';
import {emptyRecord} from '../src/schema.js';
import {demoExtractor, type Extractor} from '../src/extractor.js';

test('Gemini handles context-rich answers and preserves their exact words through save',async()=>{
 const inputs:string[]=[];
 const extractor:Extractor={mode:'gemini',async extract(text,record,question){
   inputs.push(text);
   if(!question)return demoExtractor.extract('My knee hurts.',record,null);
   const symptom=record.symptoms.find(s=>s.id===question.entityId)!;
   return {...emptyRecord(),symptoms:[{...symptom,severityScore:6,severity:null,location:'outside of left knee',duration:'since waking up yesterday',functionalImpact:'Stairs are difficult; can walk on flat ground',firstOccurrence:false,trend:'better'}]};
 }};
 const store=new Checkins(extractor);
 let state=await store.analyze({transcript:'My knee hurts.',painScale:'1-10'});
 const raw="Maybe a six. It's on the outside of my left knee since I woke up yesterday, stairs are tough but walking is okay. I had it before and it is a bit better.";
 state=await store.analyze({sessionId:state.sessionId,version:state.version,questionId:state.nextQuestion!.id,transcript:raw});
 assert.equal(inputs[1],raw);assert.equal(state.status,'review');assert.equal(state.symptoms[0].severityScore,6);
 assert.equal(state.symptoms[0].duration,'since waking up yesterday');assert.equal(state.reportedAnswers!.at(-1)!.transcript,raw);
 const saved=store.save({sessionId:state.sessionId,version:state.version,confirmed:true});assert.equal(saved.reportedAnswers!.at(-1)!.transcript,raw);
 assert.equal(saved.symptoms[0].functionalImpact,'Stairs are difficult; can walk on flat ground');
});
test('an unmatched free answer is retained without repeating or inventing a structured value',async()=>{
 const extractor:Extractor={mode:'gemini',async extract(text,record,q){return q?emptyRecord():demoExtractor.extract('My arm hurts.',record,null);}};
 const store=new Checkins(extractor);let state=await store.analyze({transcript:'My arm hurts.',painScale:'1-10'});
 const q=state.nextQuestion!;const raw='It varies so much I cannot put a number on it.';
 state=await store.analyze({sessionId:state.sessionId,version:state.version,questionId:q.id,transcript:raw});
 assert.equal(state.symptoms[0].severityScore,null);assert.notEqual(state.nextQuestion!.id,q.id);
 assert.equal(state.reportedAnswers!.at(-1)!.transcript,raw);assert.equal(state.reportedAnswers!.at(-1)!.interpretation,'unconfirmed');
});
