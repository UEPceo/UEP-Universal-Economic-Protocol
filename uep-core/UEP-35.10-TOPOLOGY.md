# UEP-35.10 — Multi-Host Topology

## Purpose
Declarative mapping of logical nodes → host:port so the same process-node binary can run on localhost or real machines.

## Topology file
```json
{
  "version": "35.10",
  "networkId": "lab-mn",
  "domainId": 1,
  "endpoints": [
    { "nodeId": "mn-0", "host": "10.0.0.1", "dataPort": 7100, "bindHost": "0.0.0.0" }
  ]
}
```

## LAB vs deploy
- Tests use localhostTopology(4)
- exampleFourMachinesTopology() documents 4 distinct hosts
- Real multi-machine deploy still requires operator networking / secrets

## Combined with 35.9 changes
Finality requires verified CommitCert + applied economic state.
