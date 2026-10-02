# UEP-33.1 — ZK on 3-node cluster + multi-host path

## 1. Groth16 obligatorio en A/B/C

```
Payment → Engine prove D=4
       → pin vk_id
       → boot 3 nodes (requireZkVerify)
       → envelope (proof+pubs+vkId)
       → B and C: Ed25519 + Groth16 VERIFY
       → same stateRoot / sequence
```

**Evidence:** `npm run test:33.zk` — Payment → A/B/C same root PASS (~5–6s).

## 2. Multi-host ready

- `listenHost: "0.0.0.0"` tested with convergence + ZK payment
- Replicas connect to sequencer host/port (lab uses 127.0.0.1 after bind-all)
- Manual 3-PC: same APIs, share genesis (registry + VK pins), point replicas at A_LAN_IP

```bash
PATH="$(pwd)/uep-core/uep-26-spend-circuit/bin:$PATH" npm run test:33
```

## Not claimed

- Live proof on three separate physical hosts inside CI
- Sequencer failover / BFT
