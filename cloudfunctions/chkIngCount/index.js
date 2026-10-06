const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const BUILD_TAG = '2026-08-15.chk-ing-count';

exports.main = async () => {
  const preset = await db.collection('ingredient_preset').count();
  const lib = await db.collection('ingredient_library').count();
  return {
    BUILD_TAG,
    preset: preset.total,
    library: lib.total,
    ingredientLibrary: preset.total + lib.total
  };
};
