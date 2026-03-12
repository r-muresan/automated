import { Hyperbrowser } from '@hyperbrowser/sdk';
import dotenv from 'dotenv';

dotenv.config();

const run = async () => {
  const client = new Hyperbrowser({
    apiKey: process.env.HYPERBROWSER_API_KEY,
  });

  const extension = await client.extensions.create({
    filePath: 'scripts/hyperbrowser-extension.zip',
    name: 'Automated Extension',
  });

  console.log('Extension uploaded:', extension.id);
  console.log('Extension name:', extension.name);
};

run();
