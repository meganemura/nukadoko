// Registers the Starlight docs collection. scripts/sync.ts writes every page of it.
import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = { docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }) };
