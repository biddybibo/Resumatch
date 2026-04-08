import formidable from 'formidable';
import pdf from 'pdf-parse';
import fs from 'fs/promises';

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
    const [fields, files] = await form.parse(req);
    
    const file = files.file?.[0];
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read the PDF file
    const dataBuffer = await fs.readFile(file.filepath);
    
    // Parse PDF
    const data = await pdf(dataBuffer);
    
    // Clean up temporary file
    await fs.unlink(file.filepath);
    
    return res.status(200).json({ text: data.text });
  } catch (error) {
    console.error('PDF parsing error:', error);
    return res.status(500).json({ error: 'Failed to parse PDF' });
  }
}
