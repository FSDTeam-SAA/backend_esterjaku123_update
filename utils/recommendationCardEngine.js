import { OpenAI } from "openai";
import { RecommendationCardAsset } from "../model/recommendationCardAsset.model.js";
import { uploadOnCloudinary } from "./commonMethod.js";
import { getEnergyFormula, getTopCorrelation } from "./insightEngine.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CARD_IMAGE_GUIDE =
  "Wide horizontal mobile wellness card background. The final app card is very wide and short, so keep all important visual details centered vertically in the middle 55% of the image. Leave the entire left 55% calm, bright, and low-detail for readable overlaid text. Put the main illustration on the right 40%. Soft pastel style, no text, no letters, no logos.";

const CARD_DEFINITIONS = {
  sleep_energy: {
    metric: "energy",
    label: "Sleep support",
    title: "Rest is your energy booster",
    actionText: "Aim for 7+ hours tonight",
    prompt: `${CARD_IMAGE_GUIDE} Peaceful bedroom at sunrise, cozy blanket, warm window light, calming lavender and peach colors.`,
  },
  walk_mood: {
    metric: "mood",
    label: "Movement boost",
    title: "Movement lifts your mood",
    actionText: "Take a 20 minute walk today",
    prompt: `${CARD_IMAGE_GUIDE} Person walking in a small green park under gentle morning sunlight, calm trees and path, lavender and mint palette.`,
  },
  hydration_focus: {
    metric: "focus",
    label: "Hydration focus",
    title: "Hydration supports your focus",
    actionText: "Drink 2 more glasses today",
    prompt: `${CARD_IMAGE_GUIDE} Clear water glass and water bottle beside a small plant on a bright desk, fresh blue and lavender palette.`,
  },
  low_stress_energy: {
    metric: "energy",
    label: "Calm reset",
    title: "Calm helps your energy",
    actionText: "Take a few quiet minutes",
    prompt: `${CARD_IMAGE_GUIDE} Peaceful breathing or meditation scene with soft sunlight, gentle lavender, cream, and green tones.`,
  },
  walk_calm: {
    metric: "calm",
    label: "Walking calm",
    title: "Walking helps you feel calmer",
    actionText: "Step outside for a short walk",
    prompt: `${CARD_IMAGE_GUIDE} Quiet walking trail with small flowers and soft sky, relaxing lavender and sage palette.`,
  },
  daily_checkin: {
    metric: "consistency",
    label: "Daily rhythm",
    title: "Your pattern starts with today",
    actionText: "Keep logging daily",
    prompt: `${CARD_IMAGE_GUIDE} Daily journal, small sun icon, cup of tea, gentle morning desk scene, lavender and peach palette.`,
  },
};

const normalizeKey = (key) =>
  CARD_DEFINITIONS[key] ? key : "daily_checkin";

const getLatestBeforeToday = (history, currentDoc) => {
  const currentDate = currentDoc?.date ? new Date(currentDoc.date) : new Date();
  const start = new Date(currentDate);
  start.setHours(0, 0, 0, 0);
  return [...history]
    .filter((doc) => new Date(doc.date) < start)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
};

const chooseRecommendation = ({ history, currentDoc, whatIf }) => {
  const energyFormula = getEnergyFormula(history);
  const topCorrelation = getTopCorrelation(energyFormula);
  if (topCorrelation?.liftPercent > 0) {
    return {
      key: normalizeKey(topCorrelation.key),
      impactText: `Your ${topCorrelation.metric} trends +${topCorrelation.liftPercent}% on days with ${topCorrelation.label.toLowerCase()}.`,
      source: "weekly",
    };
  }

  const yesterday = getLatestBeforeToday(history, currentDoc);
  if (yesterday?.walkMinutes >= 20) {
    return {
      key: "walk_mood",
      impactText: `Yesterday's ${yesterday.walkMinutes} minute walk was a strong habit to repeat.`,
      source: "yesterday",
    };
  }
  if (yesterday?.sleepHours >= 7) {
    return {
      key: "sleep_energy",
      impactText: `Yesterday's ${Math.round(yesterday.sleepHours)} hours of sleep is worth protecting tonight.`,
      source: "yesterday",
    };
  }
  if (yesterday?.waterGlasses >= 6) {
    return {
      key: "hydration_focus",
      impactText: `Yesterday's hydration rhythm is a good one to carry into today.`,
      source: "yesterday",
    };
  }

  const candidate = Array.isArray(whatIf)
    ? whatIf.find((item) => item?.label && item?.predictedText)
    : null;
  if (candidate) {
    const label = candidate.label.toLowerCase();
    const key = label.includes("walk")
      ? "walk_mood"
      : label.includes("sleep")
        ? "sleep_energy"
        : label.includes("drink") || label.includes("glass")
          ? "hydration_focus"
          : "daily_checkin";
    return {
      key,
      impactText: `${candidate.label} may help ${candidate.metric} by ${candidate.predictedText}.`,
      source: "what_if",
    };
  }

  return {
    key: "daily_checkin",
    impactText: "Keep logging daily to unlock sharper personalized motivation.",
    source: "fallback",
  };
};

const hasImageDependencies = () =>
  Boolean(
    process.env.OPENAI_API_KEY &&
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
  );

const generateAndStoreAsset = async (key, definition) => {
  if (!hasImageDependencies()) return null;

  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  try {
    const response = await openai.images.generate(
      {
        model: imageModel,
        prompt: definition.prompt,
        size: "1536x1024",
        quality: "low",
        output_format: "png",
        n: 1,
        user: `recommendation-card-${key}`,
      },
      // Hard cap so a slow/hung image call can't keep an in-flight job alive forever.
      { timeout: 30000 },
    );

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error("Image generation did not return b64_json");

    const upload = await uploadOnCloudinary(Buffer.from(b64, "base64"), {
      folder: "ester/recommendation-cards",
      public_id: `recommendation-${key}`,
      overwrite: true,
      resource_type: "image",
    });

    return await RecommendationCardAsset.findOneAndUpdate(
      { key },
      {
        key,
        metric: definition.metric,
        label: definition.label,
        imageUrl: upload.secure_url,
        publicId: upload.public_id,
        prompt: definition.prompt,
        imageModel,
        status: "ready",
        lastError: undefined,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    await RecommendationCardAsset.findOneAndUpdate(
      { key },
      {
        key,
        metric: definition.metric,
        label: definition.label,
        prompt: definition.prompt,
        imageModel,
        status: "failed",
        lastError: error.message,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.error("Recommendation card image generation failed:", error.message);
    return null;
  }
};

// Tracks keys currently generating so a burst of check-ins doesn't spawn
// several parallel image generations for the same card.
const inFlight = new Set();

const generateInBackground = (key, definition) => {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  // Intentionally not awaited: the image is produced out of the request path.
  generateAndStoreAsset(key, definition)
    .catch((err) =>
      console.error("Background card generation error:", err.message),
    )
    .finally(() => inFlight.delete(key));
};

const getCachedAsset = async (key) => {
  const definition = CARD_DEFINITIONS[normalizeKey(key)];
  const asset = await RecommendationCardAsset.findOne({
    key,
    prompt: definition.prompt,
    status: "ready",
    imageUrl: { $exists: true, $ne: "" },
  });
  if (asset) return asset;

  const lastFailed = await RecommendationCardAsset.findOne({
    key,
    status: "failed",
    updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  // Not cached yet (and not recently failed): generate in the background so the
  // image is ready on a later load, and return null now so the Check response
  // is never blocked on image generation.
  if (!lastFailed) generateInBackground(key, definition);
  return null;
};

export const buildRecommendationCard = async ({ history, currentDoc, whatIf }) => {
  const chosen = chooseRecommendation({ history, currentDoc, whatIf });
  const key = normalizeKey(chosen.key);
  const definition = CARD_DEFINITIONS[key];
  const asset = await getCachedAsset(key);

  return {
    key,
    source: chosen.source,
    metric: definition.metric,
    title: definition.title,
    message: chosen.impactText,
    actionText: definition.actionText,
    imageUrl: asset?.imageUrl || null,
  };
};
