export type ExtractInformationParams = {
  elements: string;
  extracted_information_schema?: string | null;
  previous_extracted_information?: string | null;
  error_code_mapping_str?: string | null;
  data_extraction_goal: string;
  navigation_goal?: string | null;
  current_url: string;
  extracted_text: string;
};

export function buildExtractInformationPrompt(params: ExtractInformationParams): string {
  const {
    extracted_information_schema,
    data_extraction_goal,
    previous_extracted_information,
    error_code_mapping_str,
    current_url,
    elements,
    extracted_text,
  } = params;

  const schemaSection = extracted_information_schema
    ? `output it in the specified JSON schema format:\n${extracted_information_schema} `
    : `output in strictly JSON format `;

  const previousInfoSection = previous_extracted_information
    ? `\nPrevious contexts or thoughts: \`\`\`${previous_extracted_information}\`\`\`\n`
    : '';

  const errorCodeSection = error_code_mapping_str
    ? `\nUse the error codes and their descriptions to return errors in the output, do not return any error that's not defined by the user. Don't return any outputs if the schema doesn't specify an error related field. Here are the descriptions defined by the user: ${error_code_mapping_str}\n`
    : '';

  return `You are given a screenshot, user data extraction goal, the JSON schema for the output data format, and the current URL.

Your task is to extract the requested information from the screenshot and ${schemaSection}

Add as much details as possible to the output JSON object while conforming to the output JSON schema.

Do not ever include anything other than the JSON object in your output, and do not ever include any additional fields in the JSON object.

If you are unable to extract the requested information for a specific field in the json schema, please output a null value for that field.

User Data Extraction Goal: ${data_extraction_goal}
${previousInfoSection}
${errorCodeSection}
Clickable elements from \`${current_url}\`:
\`\`\`
${elements}
\`\`\`

Current URL: ${current_url}

Text extracted from the webpage: ${extracted_text}`;
}
