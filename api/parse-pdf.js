import formidable from 'formidable';
import fs from 'fs/promises';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Workaround: pdf-parse tries to load a test file on import which breaks
// in Vercel serverless. Importing the internal module directly avoids that.
async function parsePdfBuffer(buffer) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return data.text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const form = formidable({});
    const [, files] = await form.parse(req);

    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const dataBuffer = await fs.readFile(file.filepath);
    const text = await parsePdfBuffer(dataBuffer);

    await fs.unlink(file.filepath);

    return res.status(200).json({ text });
  } catch (error) {
    console.error('PDF parsing error:', error);
    return res.status(500).json({ error: error.message });
  }
}
