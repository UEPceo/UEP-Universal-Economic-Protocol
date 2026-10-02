# UEP-STORAGE-001

## Content identity ≠ location
- `contentHash` (SHA-256) identifies content
- `locator` is provider-specific (`s3://…`, `ipfs://CID`, `mem://…`)

## StorageProvider
putObject, getObject, headObject, deleteObject, listObjects

## Adapters
- MemoryStorageProvider
- S3StorageAdapter (S3-compatible transport injection)
- IPFSStorageAdapter (HTTP/lab transport)

## Integrity
Download must match `contentHash` or `CONTENT_INTEGRITY_ERROR`.

## Non-coupling
Storage failure does not stop UEP CORE consensus.
