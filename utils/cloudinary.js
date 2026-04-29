const cloudinary = require("cloudinary").v2;
require("dotenv").config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload image to Cloudinary
 * @param {Buffer} imageBuffer - Image file buffer
 * @param {string} folder - Folder path in Cloudinary (e.g., 'avatars')
 * @param {string} publicId - Public ID for the image (optional)
 * @returns {Promise<Object>} Cloudinary upload result
 */
const uploadImage = async (imageBuffer, folder = "avatars", publicId = null) => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: folder,
      resource_type: "image",
      transformation: [
        {
          width: 400,
          height: 400,
          crop: "fill",
          gravity: "face",
          quality: "auto",
          fetch_format: "auto",
        },
      ],
    };

    if (publicId) {
      uploadOptions.public_id = publicId;
      uploadOptions.overwrite = true;
    }

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error("Cloudinary upload error:", error);
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    uploadStream.end(imageBuffer);
  });
};

/**
 * Delete image from Cloudinary
 * @param {string} publicId - Public ID of the image to delete
 * @returns {Promise<Object>} Cloudinary deletion result
 */
const deleteImage = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    throw error;
  }
};

/**
 * Extract public ID from Cloudinary URL
 * @param {string} url - Cloudinary URL
 * @returns {string|null} Public ID or null
 */
const extractPublicId = (url) => {
  if (!url) return null;
  const match = url.match(/\/v\d+\/(.+)\.(jpg|jpeg|png|gif|webp)/i);
  return match ? match[1] : null;
};

module.exports = {
  uploadImage,
  deleteImage,
  extractPublicId,
  cloudinary,
};

