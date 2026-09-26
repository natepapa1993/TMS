import { customAlphabet } from "nanoid";

// URL-safe, no ambiguous characters, 16 chars ≈ 83 bits
const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
const gen = customAlphabet(alphabet, 16);

export const newId = () => gen();
