import { defineConfig } from '@hey-api/openapi-ts';
export default defineConfig({input:process.env.PLATFORM_OPENAPI_OUTPUT??'packages/contracts/openapi/platform.json',output:{path:process.env.PLATFORM_SDK_OUTPUT??'packages/sdk/src/generated',module:{extension:'.js'}},plugins:['@hey-api/typescript','@hey-api/sdk','@hey-api/client-fetch']});
