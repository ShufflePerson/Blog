import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
	type: 'content', // Use `type: 'content'` for Markdown/MDX
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: image().optional(),
			// Add this new field for the social embed image
			socialImage: image().optional(),
			tags: z.array(z.string()), // Added tags based on your frontmatter example
		}),
});

export const collections = { blog };