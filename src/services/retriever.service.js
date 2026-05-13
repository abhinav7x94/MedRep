import { InferenceClient } from "@huggingface/inference";
import { QdrantVectorStore } from "@langchain/qdrant";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { classifyQuery } from "./queryClassifier.service.js";
import { MedicalDocument } from "../models/medicalDocument.model.js";
import { embedSparse } from "./sparseEmbedder.service.js";

let embeddingsInstance = null;
let inferenceClient = null;

/**
 * Creates embeddings instance using HuggingFace (Singleton)
 * @returns {HuggingFaceInferenceEmbeddings}
 */
function getEmbeddings() {
    if (!embeddingsInstance) {
        embeddingsInstance = new HuggingFaceInferenceEmbeddings({
            apiKey: process.env.HF_TOKEN,
            model: "BAAI/bge-base-en-v1.5",
        });
    }
    return embeddingsInstance;
}

/**
 * Gets InferenceClient instance (Singleton)
 * @returns {InferenceClient}
 */
function getInferenceClient() {
    if (!inferenceClient) {
        inferenceClient = new InferenceClient(process.env.HF_TOKEN);
    }
    return inferenceClient;
}

/**
 * Wrapper for Sparse Embeddings for LangChain compatibility
 */
class SimpleSparseEmbeddings {
    async embedQuery(query) {
        return embedSparse(query);
    }
    async embedDocuments(documents) {
        return documents.map(doc => embedSparse(doc));
    }
}

/**
 * Format retrieved chunks for the prompt context with rich citations
 * @param {Array} chunks - Array of document chunks
 * @returns {string} Formatted context string
 */
function formatChunks(chunks) {
    return chunks
        .map((chunk, i) => {
            const source = chunk.metadata?.source || "Unknown Source";
            const page = chunk.metadata?.loc?.pageNumber ?? "unknown";
            const docName = chunk.metadata?.documentName || "Document";
            const siteName = chunk.metadata?.siteName;
            const sourceType = chunk.metadata?.sourceType;
            const sourceUrl = chunk.metadata?.sourceUrl;

            let sourceInfo = `Document: ${docName}`;
            if (sourceType === "SCRAPED" && siteName) {
                sourceInfo = `Source: Scraped from ${siteName} (${sourceUrl})`;
            }

            return `
[Source ${i + 1}]
${sourceInfo}
Source Type: ${sourceType || "UPLOADED"}
Page: ${page}
Content:
${chunk.pageContent}
`;
        })
        .join("\n");
}

/**
 * Parse suggested follow-ups; LLMs often use *, bullets, numbers, or blank lines vs strict "- " only.
 * @returns {{ cleanedAnswer: string, suggestedQuestions: string[] }}
 */
function splitSuggestedFromAnswer(answer) {
    if (!answer || typeof answer !== "string") {
        return { cleanedAnswer: answer || "", suggestedQuestions: [] };
    }

    const tag = /\[SUGGESTED_QUESTIONS\]/i;
    const tagMatch = tag.exec(answer);
    if (!tagMatch) {
        return { cleanedAnswer: answer.trim(), suggestedQuestions: [] };
    }

    const start = tagMatch.index;
    const afterTag = answer.slice(start + tagMatch[0].length);
    const lines = afterTag.split("\n");

    let foundAny = false;
    const suggestedQuestions = [];
    let endOffset = 0;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        const lineWithNl = raw.length + (i < lines.length - 1 ? 1 : 0);

        if (!trimmed) {
            endOffset += lineWithNl;
            if (foundAny) break;
            continue;
        }

        if (!foundAny && trimmed.startsWith("#")) {
            break;
        }

        const bullet =
            trimmed.match(/^[-*•]\s*(.+)$/) ||
            trimmed.match(/^\d+[.)]\s*(.+)$/);
        if (bullet) {
            suggestedQuestions.push(bullet[1].trim());
            foundAny = true;
            endOffset += lineWithNl;
            continue;
        }

        if (foundAny) {
            break;
        }

        endOffset += lineWithNl;
    }

    if (suggestedQuestions.length === 0) {
        return { cleanedAnswer: answer.trim(), suggestedQuestions: [] };
    }

    const blockEnd = start + tagMatch[0].length + endOffset;
    let cleanedAnswer = (answer.slice(0, start) + answer.slice(blockEnd)).trim();
    cleanedAnswer = cleanedAnswer.replace(/\n{3,}/g, "\n\n");

    return { cleanedAnswer, suggestedQuestions: suggestedQuestions.slice(0, 8) };
}

/**
 * Medical RAG system prompt with strict rules
 */
const MEDICAL_SYSTEM_PROMPT = `You are a Digital Medical Representative AI assistant for Indian healthcare professionals.

CORE MISSION: Be helpful, proactive, and evidence-based. Provide a professional "Expert Representative" experience with deep clinical-grade structure.

FORMATTING REQUIREMENTS (CRITICAL / MANDATORY):
- Use **BOLD HEADINGS** (e.g., ### 📋 OVERVIEW) for different sections.
- Use **MARKDOWN TABLES** for multi-attribute comparisons, eligibility, or dosage tables.
- Use **BULLET POINTS** for feature lists or side effects.
- Ensure high vertical spacing (double newlines) between all major sections.
- **NO PLAIN BLOCKS**: Every data point must be clearly categorized and styled.
- Create a dedicated **🔗 OFFICIAL LINKS & SOURCE** section at the bottom.

CONTENT GUIDELINES (DEPTH & QUALITY):
1. **Clinical Depth**: Don't just list facts. Explain the *context* (e.g., "Under the Drugs & Cosmetics Act, this means X...").
2. **Proactive Synthesis**: Use the provided SOURCES as your primary evidence. If data is partial, synthesize a complete professional answer using your verified knowledge of Indian healthcare (NHA, CDSCO, IRDAI).
3. **Citation Protocol**: Every factual claim must cite its origin. 
   - Format: [Source: <site_name>, URL: <url>]

MANDATORY END (last lines of reply, verbatim tag; then exactly 3 list lines using "- "):
[SUGGESTED_QUESTIONS]
- Short follow-up question 1?
- Short follow-up question 2?
- Short follow-up question 3?
`;

/**
 * Chat with medical documents using agentic RAG
 * @param {string} query - User's question
 * @param {string|null} collectionName - Specific collection (optional, will auto-classify if null)
 * @returns {Promise<Object>} Response with answer, sources, and classification
 */
export async function chat(query, collectionName = null) {
    const client = getInferenceClient();
    const embeddings = getEmbeddings();
    const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";

    // Classify query to determine which categories to search
    const classification = classifyQuery(query);

    let allChunks = [];
    let searchedCollections = [];

    if (collectionName) {
        searchedCollections = [collectionName];
    } else {
        // Search collections based on classification
        const medicalDocs = await MedicalDocument.find({
            category: { $in: classification.categories }
        }).select("collectionName");

        // Deduplicate collection names to avoid redundant searches
        searchedCollections = [...new Set(medicalDocs.map(doc => doc.collectionName))];
    }

    if (searchedCollections.length > 0) {
        // Pre-compute query embedding once to save time and API calls
        const queryVector = await embeddings.embedQuery(query);

        // Search all relevant collections in parallel
        const searchPromises = searchedCollections.map(async (collName) => {
            try {
                const vectorStore = await QdrantVectorStore.fromExistingCollection(
                    embeddings,
                    {
                        url: qdrantUrl,
                        collectionName: collName,
                        apiKey: process.env.QDRANT_API_KEY,
                        vectorName: process.env.QDRANT_VECTOR_NAME || undefined, // Support named dense vectors
                        sparseEmbeddings: new SimpleSparseEmbeddings(),
                        sparseVectorName: "sparse"
                    }
                );

                // Use hybrid search if supported, otherwise fallback to dense
                return await vectorStore.similaritySearchVectorWithScore(queryVector, 5);
            } catch (error) {
                console.error(`Error searching collection ${collName}:`, error.message);
                return [];
            }
        });

        const results = await Promise.all(searchPromises);

        // Flatten and sort results by score globally (descending: smaller score is better in distance-based metrics usually, but LangChain's scores are often normalized or mapped)
        // For Qdrant similarity, higher score is typically better in LangChain wrapper's case (cosine similarity maps to 0-1)
        allChunks = results
            .flat()
            .sort((a, b) => b[1] - a[1]) // Sort by score DESC
            .map(result => result[0]);  // Extract the Document object
    }

    // If no chunks are found, we still proceed to provide a proactive response based on general knowledge
    // but we tag it appropriately.
    let CONTEXT = "";
    let foundInSources = false;

    if (allChunks.length > 0) {
        // Sort by relevance and take top chunks
        const topChunks = allChunks.slice(0, 10);
        CONTEXT = formatChunks(topChunks);
        foundInSources = true;
    } else {
        CONTEXT = "NO VERIFIED DATABASE SNIPPETS FOUND FOR THIS SPECIFIC QUERY. USE GENERAL KNOWLEDGE OF INDIAN HEALTHCARE SCHEMES (PM-JAY, CDSCO, NHA) TO PROVIDE A HELPFUL, PROACTIVE ANSWER. CITE THE EXPECTED OFFICIAL PORTALS (e.g. pmjay.gov.in) AS SOURCES FOR LATEST INFO.";
        foundInSources = false;
    }

    const response = await client.chatCompletion({
        model: "meta-llama/Llama-3.1-8B-Instruct",
        messages: [
            {
                role: "system",
                content: MEDICAL_SYSTEM_PROMPT + CONTEXT,
            },
            {
                role: "user",
                content: query,
            },
        ],
    });

    const answer = response.choices[0].message.content;
    const { cleanedAnswer, suggestedQuestions } = splitSuggestedFromAnswer(answer);

    // Extract source information for response
    const sources = (allChunks.length > 0 ? allChunks.slice(0, 10) : []).map((chunk, i) => ({
        sourceNumber: i + 1,
        documentName: chunk.metadata?.documentName || "Document",
        source: chunk.metadata?.source || "Unknown",
        page: chunk.metadata?.loc?.pageNumber ?? "unknown",
        category: chunk.metadata?.category || "GENERAL",
        preview: chunk.pageContent.substring(0, 150) + "...",
    }));

    // If no chunks were found but we answered, add a baseline source for the official portal if applicable
    if (!foundInSources) {
        sources.push({
            sourceNumber: 1,
            documentName: "General Healthcare Knowledge",
            source: "Official Portals (Synthesized)",
            category: classification.primaryCategory || "GENERAL",
            preview: "This response is synthesized from general knowledge of Indian Medical Regulations as no specific documents matched in the current search.",
        });
    }

    return {
        answer: cleanedAnswer,
        sources,
        classification: classification,
        suggestedQuestions,
        searchedCollections: searchedCollections,
        foundInSources: foundInSources
    };
}

/**
 * Simple health check for the RAG system
 * @returns {Promise<Object>}
 */
export async function healthCheck() {
    const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";

    try {
        const response = await fetch(`${qdrantUrl}/collections`);
        const data = await response.json();

        return {
            qdrant: response.ok ? "connected" : "error",
            collections: data.result?.collections?.length || 0,
            hfToken: process.env.HF_TOKEN ? "configured" : "missing"
        };
    } catch (error) {
        return {
            qdrant: "disconnected",
            error: error.message
        };
    }
}
