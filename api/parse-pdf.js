import formidable from 'formidable';
import fs from 'fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const config = {
  api: {
    bodyParser: false,
  },
};

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

    // Read the PDF file
    const dataBuffer = await fs.readFile(file.filepath);
    const uint8 = new Uint8Array(dataBuffer);

    // Parse PDF using pdfjs-dist (works in Vercel serverless)
    const pdf = await getDocument({ data: uint8 }).promise;

    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }

    // Clean up temporary file
    await fs.unlink(file.filepath);

    return res.status(200).json({ text });
  } catch (error) {
    console.error('PDF parsing error:', error);
    return res.status(500).json({ error: error.message });
  }
}
