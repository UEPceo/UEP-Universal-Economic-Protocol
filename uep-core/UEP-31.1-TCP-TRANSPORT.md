# UEP-31.1 — TCP transport

Length-prefixed JSON NodeEnvelope over 127.0.0.1.

Lab ports default 3101–3103 (tests use 13101–13103).

Messages: envelope | hello | catchup_req | catchup_res

Adversarial: duplicate, tampered sig, stale root — replicas refuse.

## Topology

Star: replicas open TCP to sequencer. Sequencer broadcasts `envelope` / `catchup_res` to all sockets.

## Tests (`npm run test:31`)

- 3-node convergence
- Late join catch-up
- N1 duplicate, N2 bad sig, N3 stale root

9/9 with in-process + TCP suites.
