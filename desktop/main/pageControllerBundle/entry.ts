import {
  PageController,
  clickElement,
  inputTextElement,
  scrollHorizontally,
  scrollVertically,
  selectOptionElement
} from "@page-agent/page-controller";

declare global {
  interface Window {
    __ArivuPageControllerLib?: {
      PageController: typeof PageController;
      clickElement: typeof clickElement;
      inputTextElement: typeof inputTextElement;
      scrollHorizontally: typeof scrollHorizontally;
      scrollVertically: typeof scrollVertically;
      selectOptionElement: typeof selectOptionElement;
    };
  }
}

window.__ArivuPageControllerLib = {
  PageController,
  clickElement,
  inputTextElement,
  scrollHorizontally,
  scrollVertically,
  selectOptionElement
};
