import { describe, it, expect } from 'vitest';
import { isMastraStorageInitError } from '../test/ignore-mastra-storage-init-rejection';

// These pin the suppression filter against the SHAPES the leaked test-store rejection actually
// takes, so it keeps working regardless of DNS/timing (the review saw ~18 escape when the
// wrapped root cause surfaced instead of the MastraError wrapper). A real defect must still throw.
describe('isMastraStorageInitError', () => {
  it('matches the MastraError id form', () => {
    expect(isMastraStorageInitError({ id: 'MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED' })).toBe(true);
  });

  it('matches the "create default index" text form', () => {
    expect(isMastraStorageInitError(new Error('Failed to create default index on collection "mastra_messages".'))).toBe(true);
  });

  it('matches when the MastraError WRAPS a MongoDB server-selection cause (the real shape)', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND c.mongodb.net'), { name: 'MongoServerSelectionError' });
    const wrapper = Object.assign(new Error('Failed to create default index on collection "mastra_threads".'), {
      id: 'MASTRA_STORAGE_MONGODB_CREATE_DEFAULT_INDEXES_FAILED', cause,
    });
    expect(isMastraStorageInitError(wrapper)).toBe(true);
  });

  it('matches a bare SRV DNS failure against the fake atlas host (cause surfaced alone)', () => {
    expect(isMastraStorageInitError(new Error('querySrv ENOTFOUND _mongodb._tcp.c.mongodb.net'))).toBe(true);
  });

  it('does NOT swallow an unrelated rejection (real defects still throw)', () => {
    expect(isMastraStorageInitError(new Error('TypeError: cannot read property of undefined'))).toBe(false);
    expect(isMastraStorageInitError('some other failure')).toBe(false);
    // A generic DNS error with no Mongo/Atlas context is NOT ours.
    expect(isMastraStorageInitError(new Error('getaddrinfo ENOTFOUND example.com'))).toBe(false);
  });
});
