import formidable from 'formidable';
import mammoth from 'mammoth';
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

    // Read the DOC/DOCX file
    const result = await mammoth.extractRawText({ path: file.filepath });
    
    // Clean up temporary file
    await fs.unlink(file.filepath);
    
    return res.status(200).json({ text: result.value });
  } catch (error) {
    console.error('Document parsing error:', error);
    return res.status(500).json({ error: 'Failed to parse document' });
  }
}
