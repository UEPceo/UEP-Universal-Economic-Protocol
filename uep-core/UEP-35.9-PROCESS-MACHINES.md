# UEP-35.9 — One Process per Node / 4 Machines (LAB)

## Model
```text
Parent (orchestrator)
   │  stdin JSON control
   ├── Process mn-0  ←→ TCP mesh ←→ Process mn-1
   ├── Process mn-2  ←→ TCP mesh ←→ Process mn-3
```

Each child has:
- isolated memory / economic state / DAG / registry copy
- Ed25519 identity from bootstrap file
- TCP data plane
- consensus: PROPOSAL → VOTE → CommitCert → FinalityCert

## Demonstrated
- 4 OS processes spawned
- TCP mesh between processes
- propose from mn-0
- all 4 finalize with **same stateRoot**

## LAB limits
- Still one physical host (localhost ports)
- Bootstrap file holds all private keys (test only)
- Not multi-datacenter / not production ops

## Not yet
- Real multi-machine IPs / firewall
- Secret injection per host
- systemd / k8s packaging
