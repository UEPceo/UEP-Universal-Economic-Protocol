import { DigitalServicesMarketplace } from '../src/marketplace/marketplace.ts';
import { createMarketplaceIdentity, signReservation } from '../src/marketplace/identity.ts';
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
// v0.4.3: only registered identities with funds can reserve, and every reservation is buyer-signed.
function enroll(id, credit){ const who=createMarketplaceIdentity(id); m.registerIdentity(id, who.publicKeyHex); m.creditAccount(id,'EUR',credit); return who; }
function signedReserve(who, listingId, quantity, idempotencyKey){
  const signature=signReservation({marketplaceId:m.marketplaceId,listingId,buyerId:who.identityId,quantity,idempotencyKey},who.privateKey);
  return m.reserve({listingId,buyerId:who.identityId,quantity,idempotencyKey,signature});
}
const countries=Array.from({length:20000},(_,i)=>regions[i%regions.length]);
let accepted=0, fund=0, delivered=0, settled=0, cancelled=0, errors=0, idempotent=0;
const t0=performance.now();
for(let i=0;i<20000;i++){
  const l=listings[i%listings.length]; const buyer=`buyer-${i}`; const idem=`checkout-${i}`;
  try{
    const who=enroll(buyer, 1_000n);
    const o=signedReserve(who,l.listingId,1n,idem); accepted++;
    const o2=signedReserve(who,l.listingId,1n,idem); if(o2.orderId===o.orderId) idempotent++;
    m.fundOrder(o.orderId,o.fundingDue,`fund-${i}`); fund++; // deposit locked at reserve() counts toward payment
    m.deliver(o.orderId,l.providerId,Buffer.from(`LICENSE:${i}`),`deliver-${i}`); delivered++;
    m.settle(o.orderId,buyer); settled++;
    if(i%100===0) m.recordSellerReview({orderId:o.orderId,buyerId:buyer,rating:(i%5+1)});
  } catch(e){ errors++; }
}
const t1=performance.now();
// high-contention single listing test (capacity 100) with 1000 buyers
const hot=m.publishListing({providerId:'hot-provider',title:'Hot H100 Capacity',description:'concurrent GPU',category:'COMPUTE',asset:'EUR',unitPrice:50n,capacity:100n});
let hotAccepted=0, hotRejected=0;
for(let i=0;i<1000;i++){const who=enroll(`hot-${i}`, 100n);try{signedReserve(who,hot.listingId,1n,`hot-${i}`);hotAccepted++;}catch{hotRejected++;}}
const t2=performance.now();
const accounting=m.valueAccounting('EUR');
if(!accounting.conserved) errors++;
console.log(JSON.stringify({users:20000,regions,providers:200,listings:listings.length,listingFailures,accepted,fund,delivered,settled,cancelled,errors,idempotentReplayChecks:idempotent,hotCapacity:100,hotAccepted,hotRejected,hotRemaining:m.getListing(hot.listingId).available,totalTreasuryEUR:String(m.treasury.totalOf('EUR')),valueConserved:accounting.conserved,lockedDepositsEUR:accounting.lockedDeposits,durationMs:Math.round(t2-start),mainFlowMs:Math.round(t1-t0),contentionMs:Math.round(t2-t1),orders:m.listOrders().length},(k,v)=>typeof v==='bigint'?v.toString():v,2));
if(errors>0||listingFailures>0) process.exitCode=1;
