
  # 资产助手

  This is a code bundle for 资产助手. The original project is available at https://www.figma.com/design/e7hzlcbaacCPyhTwL5BwoQ/%E8%B5%84%E4%BA%A7%E5%8A%A9%E6%89%8B.

  ## Running the code

  Run `npm i` to install the dependencies.

  Run `npm run dev` to start the development server.

  ## Load In Chrome

  This project needs to be built before Chrome can load it as an extension.

  1. Run `npm i`
  2. Run `npm run build:extension`
  3. Open `chrome://extensions`
  4. Turn on `Developer mode`
  5. Click `Load unpacked`
  6. Select the generated `dist` folder

  Chrome should read `dist/manifest.json` and use `dist/index.html` as the popup.
  
