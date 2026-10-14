# Sandbox

One command. Local node, Marketplace, IoT service and a sample order. Not a second network.

```text
npm run sandbox
```

Expected last line: `SANDBOX OK`.

That command registers a provider and a buyer, credits the buyer, publishes a listing, reserves, funds, delivers and settles through the SDK against the local API. Fees stay 0.1 % protocol and 3 % Marketplace.

To leave the node open:

```text
npm run sandbox:serve
```

It listens on `http://127.0.0.1:8787`. Sample identities are not preloaded in that mode.
