import { DigitalServicesMarketplace } from '../src/marketplace/marketplace.ts';
import { performance } from 'node:perf_hooks';

const regions=['EU','NA','LATAM','APAC','AFRICA','MENA'];
const m=new DigitalServicesMarketplace();
const start=performance.now();
const listings=[];
let listingFailures=0;
// 200 providers, each 5 listings = 1000 listings
for(let p=0;p<200;p++) for(let j=0;j<5;j++){
  try { listings.push(m.publishListing({providerId:`prov-${p}`,title:`Compute service ${p}-${j}`,description:'GPU compute service for digital workloads',category:j%4===0?'COMPUTE':j%4===1?'STORAGE':j%4===2?'API':'DATA',asset:'EUR',unitPrice:100n+BigInt(j),capacity:100n})); } catch { listingFailures++; }
}
const countries=Array.from({length:20000},(_,i)=>regions[i%regions.length]);
let accepted=0, fund=0, delivered=0, settled=0, cancelled=0, errors=0, idempotent=0;
const t0=performance.now();
for(let i=0;i<20000;i++){
  const l=listings[i%listings.length]; const buyer=`buyer-${i}`; const idem=`checkout-${i}`;
  try{
    const o=m.acceptOrder({listingId:l.listingId,buyerId:buyer,quantity:1n,idempotencyKey:idem}); accepted++;
    const o2=m.acceptOrder({listingId:l.listingId,buyerId:buyer,quantity:1n,idempotencyKey:idem}); if(o2.orderId===o.orderId) idempotent++;
    m.fundOrder(o.orderId,o.grossAmount,`fund-${i}`); fund++;
    m.deliver(o.orderId,l.providerId,Buffer.from(`LICENSE:${i}`),`deliver-${i}`); delivered++;
    m.settle(o.orderId); settled++;
    if(i%100===0) m.recordSellerReview({orderId:o.orderId,buyerId:buyer,rating:(i%5+1)});
  } catch(e){ errors++; }
}
const t1=performance.now();
// high-contention single listing test (capacity 100) with 1000 buyers
const hot=m.publishListing({providerId:'hot-provider',title:'Hot H100 Capacity',description:'concurrent GPU',category:'COMPUTE',asset:'EUR',unitPrice:50n,capacity:100n});
let hotAccepted=0, hotRejected=0;
for(let i=0;i<1000;i++){try{m.acceptOrder({listingId:hot.listingId,buyerId:`hot-${i}`,quantity:1n,idempotencyKey:`hot-${i}`});hotAccepted++;}catch{hotRejected++;}}
const t2=performance.now();
console.log(JSON.stringify({users:20000,regions,providers:200,listings:listings.length,listingFailures,accepted,fund,delivered,settled,cancelled,errors,idempotentReplayChecks:idempotent,hotCapacity:100,hotAccepted,hotRejected,hotRemaining:m.getListing(hot.listingId).available,totalTreasuryEUR:String(m.treasury.totalOf('EUR')),durationMs:Math.round(t2-start),mainFlowMs:Math.round(t1-t0),contentionMs:Math.round(t2-t1),orders:m.listOrders().length},(k,v)=>typeof v==='bigint'?v.toString():v,2));
