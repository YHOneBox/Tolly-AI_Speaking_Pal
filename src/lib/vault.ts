import { Stronghold } from "@tauri-apps/plugin-stronghold";

import { invoke } from "@tauri-apps/api/core";

const CLIENT_NAME = "speaking-pal";
const GROQ_RECORD = "groq_api_key";
const CARTESIA_RECORD = "cartesia_api_key";

type VaultUnlock = {
  snapshotPath: string;
  password: string;
};

let chain: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function openClient() {
  const unlock = await invoke<VaultUnlock>("stronghold_unlock");
  const stronghold = await Stronghold.load(unlock.snapshotPath, unlock.password);
  try {
    const client = await stronghold.loadClient(CLIENT_NAME);
    return { stronghold, client };
  } catch {
    const client = await stronghold.createClient(CLIENT_NAME);
    return { stronghold, client };
  }
}

function encode(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function decode(bytes: Uint8Array | null): string | null {
  if (!bytes || bytes.length === 0) {
    return null;
  }
  const text = new TextDecoder().decode(bytes).trim();
  return text.length > 0 ? text : null;
}

export function mirrorKeysToStronghold(groqKey?: string, cartesiaKey?: string): Promise<void> {
  return exclusive(async () => {
    const { stronghold, client } = await openClient();
    try {
      const store = client.getStore();
      if (groqKey) {
        await store.insert(GROQ_RECORD, encode(groqKey));
      }
      if (cartesiaKey) {
        await store.insert(CARTESIA_RECORD, encode(cartesiaKey));
      }
      await stronghold.save();
    } finally {
      await stronghold.unload();
    }
  });
}

export function readKeysFromStronghold(): Promise<{ groq: string | null; cartesia: string | null }> {
  return exclusive(async () => {
    const { stronghold, client } = await openClient();
    try {
      const store = client.getStore();
      const groq = decode(await store.get(GROQ_RECORD));
      const cartesia = decode(await store.get(CARTESIA_RECORD));
      return { groq, cartesia };
    } finally {
      await stronghold.unload();
    }
  });
}

export function clearStrongholdKeys(): Promise<void> {
  return exclusive(async () => {
    const { stronghold, client } = await openClient();
    try {
      const store = client.getStore();
      await store.remove(GROQ_RECORD);
      await store.remove(CARTESIA_RECORD);
      await stronghold.save();
    } finally {
      await stronghold.unload();
    }
  });
}
