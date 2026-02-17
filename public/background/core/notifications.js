export async function sendNotification(title, message) {
  let messageText = "This is the notification message.";

  if (message) {
    if (typeof message === "string") {
      messageText = message;
    } else if (typeof message === "object") {
      if (message.error) {
        messageText = message.error;
      } else if (message.message) {
        messageText = message.message;
      } else {
        messageText = JSON.stringify(message);
      }
    } else {
      messageText = String(message);
    }
  }

  chrome.notifications.create({
    type: "basic",
    iconUrl: "https://ik.imagekit.io/d5ik6mphn/icon128.png",
    title: title || "Notification Title",
    message: messageText,
    priority: 1,
  });
}

