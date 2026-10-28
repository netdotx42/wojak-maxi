import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { create } from "zustand";

let keypair: Keypair | null = null;

type SignerState = {
  publicKey: string | null;
  error: string | null;
};

export const useSigner = create<SignerState>(() => ({
  publicKey: null,
  error: null,
}));

export function signerPublicKey() {
  return keypair?.publicKey.toBase58() ?? null;
}

export function loadSecret(raw: string) {
  const text = raw.trim();
  if (!text) throw new Error("Paste the private key first.");
  let bytes: Uint8Array;
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "number")) {
      throw new Error("That is not a key array.");
    }
    bytes = Uint8Array.from(parsed);
  } else {
    bytes = bs58.decode(text);
  }
  if (bytes.length !== 64) {
    throw new Error("Paste the private key, not the wallet address.");
  }
  const next = Keypair.fromSecretKey(bytes);
  keypair = next;
  useSigner.setState({ publicKey: next.publicKey.toBase58(), error: null });
  return next.publicKey.toBase58();
}

export function clearSecret() {
  keypair = null;
  useSigner.setState({ publicKey: null, error: null });
}

export function signSwap(txBase64: string) {
  if (!keypair) throw new Error("No live key is loaded in this tab.");
  const tx = VersionedTransaction.deserialize(decodeBase64(txBase64));
  tx.sign([keypair]);
  return encodeBase64(tx.serialize());
}

function decodeBase64(value: string) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}
